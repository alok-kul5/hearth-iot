"""Hysteresis (`clear_at`) and the shipped wellness rules in rules.yaml."""

import pytest

from app.config import APP_DIR
from app.models import Reading
from app.rules import AlertEngine, Rule

SHIPPED = AlertEngine.from_yaml(APP_DIR / "rules.yaml")


def shipped(name):
    return next(r for r in SHIPPED.rules if r.name == name)


def reading(value, ts, sensor_id, type_):
    return Reading(sensor_id=sensor_id, room="r", type=type_, value=value, unit="x", ts=1000 + ts)


def kinds(events):
    return [e.kind for e in events]


def test_clear_at_keeps_alert_open_until_value_is_well_back():
    eng = AlertEngine([Rule("co2_high", "co2", ">", 1000, clear_at=800)])
    assert kinds(eng.evaluate(reading(1100, 1, "c1", "co2"))) == ["opened"]
    assert eng.evaluate(reading(950, 2, "c1", "co2")) == []  # below 1000 but not yet below 800
    assert eng.evaluate(reading(850, 3, "c1", "co2")) == []
    assert kinds(eng.evaluate(reading(790, 4, "c1", "co2"))) == ["resolved"]


def test_clear_at_works_for_low_limits_too():
    eng = AlertEngine([Rule("too_low", "tds", "<", 30, clear_at=40)])
    eng.evaluate(reading(20, 1, "w", "tds"))
    assert eng.evaluate(reading(35, 2, "w", "tds")) == []
    assert kinds(eng.evaluate(reading(45, 3, "w", "tds"))) == ["resolved"]


@pytest.mark.parametrize(
    "kwargs",
    [
        {"op": ">", "threshold": 1000, "clear_at": 1200},  # clear level on the wrong side
        {"op": "<", "threshold": 30, "clear_at": 20},
        {"op": "==", "threshold": 1, "clear_at": 0},
        {"op": "~", "threshold": 1},
    ],
)
def test_bad_rules_are_refused(kwargs):
    with pytest.raises(ValueError):
        Rule("bad", "co2", **kwargs)


def test_shipped_rules_cover_every_wellness_sensor():
    assert {"co2", "pm25", "voc", "tds", "leak"} <= {r.sensor_type for r in SHIPPED.rules}


def test_co2_over_1000_for_five_minutes_turns_ventilation_on():
    rule = shipped("co2_high")
    assert rule.activates == ("erv-main",)
    eng = AlertEngine([rule])
    assert eng.evaluate(reading(1050, 0, "co2-bedroom", "co2")) == []
    assert eng.evaluate(reading(1200, 299, "co2-bedroom", "co2")) == []
    opened = eng.evaluate(reading(1200, 300, "co2-bedroom", "co2"))
    assert [(e.kind, e.severity) for e in opened] == [("opened", "warning")]
    assert "1200.0 ppm" in opened[0].message
    assert eng.evaluate(reading(900, 400, "co2-bedroom", "co2")) == []  # hysteresis
    assert kinds(eng.evaluate(reading(780, 500, "co2-bedroom", "co2"))) == ["resolved"]


def test_short_co2_peak_does_not_open():
    eng = AlertEngine([shipped("co2_high")])
    eng.evaluate(reading(1100, 0, "c", "co2"))
    eng.evaluate(reading(990, 200, "c", "co2"))  # dipped under: timer resets
    assert eng.evaluate(reading(1100, 250, "c", "co2")) == []
    assert eng.evaluate(reading(1100, 520, "c", "co2")) == []


def test_cooking_smoke_opens_pm25_alert():
    rule = shipped("pm25_high")
    assert rule.activates == ("erv-main",)
    eng = AlertEngine([rule])
    eng.evaluate(reading(60, 0, "pm25-kitchen", "pm25"))
    assert kinds(eng.evaluate(reading(80, 30, "pm25-kitchen", "pm25"))) == ["opened"]
    assert eng.evaluate(reading(20, 60, "pm25-kitchen", "pm25")) == []
    assert kinds(eng.evaluate(reading(12, 90, "pm25-kitchen", "pm25"))) == ["resolved"]


def test_voc_spike_opens_alert_and_runs_ventilation():
    rule = shipped("voc_high")
    assert rule.activates == ("erv-main",)
    eng = AlertEngine([rule])
    eng.evaluate(reading(800, 0, "voc-living", "voc"))
    assert kinds(eng.evaluate(reading(700, 60, "voc-living", "voc"))) == ["opened"]
    assert kinds(eng.evaluate(reading(250, 120, "voc-living", "voc"))) == ["resolved"]


def test_leak_is_critical_and_immediate():
    eng = AlertEngine([shipped("water_leak")])
    assert eng.evaluate(reading(0, 0, "leak-bathroom", "leak")) == []
    opened = eng.evaluate(reading(1, 1, "leak-bathroom", "leak"))
    assert [(e.kind, e.severity, e.message) for e in opened] == [("opened", "critical", "Water detected")]
    assert kinds(eng.evaluate(reading(0, 2, "leak-bathroom", "leak"))) == ["resolved"]


@pytest.mark.parametrize("value,rule", [(380, "tds_high"), (12, "tds_low")])
def test_tds_out_of_range_warns(value, rule):
    eng = AlertEngine([shipped("tds_high"), shipped("tds_low")])
    assert eng.evaluate(reading(85, 0, "tds-kitchen", "tds")) == []
    eng.evaluate(reading(value, 1, "tds-kitchen", "tds"))
    opened = eng.evaluate(reading(value, 11, "tds-kitchen", "tds"))
    assert [(e.rule, e.severity) for e in opened] == [(rule, "warning")]


def test_normal_tds_never_alerts():
    eng = AlertEngine([shipped("tds_high"), shipped("tds_low")])
    for i, v in enumerate(range(40, 290, 10)):
        assert eng.evaluate(reading(v, i * 10, "tds-kitchen", "tds")) == []
