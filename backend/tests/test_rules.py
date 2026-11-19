from app.models import Reading
from app.rules import AlertEngine, Rule

HOT = Rule("high_temperature", "temperature", ">", 30, severity="critical", message="{value} > {threshold}")
DOOR = Rule("door_left_open", "door", "==", 1, for_seconds=60)


def reading(value, ts, sensor_id="t1", type_="temperature"):
    return Reading(sensor_id=sensor_id, room="kitchen", type=type_, value=value, unit="x", ts=ts)


def test_alert_opens_once_and_resolves_when_back_in_range():
    eng = AlertEngine([HOT])
    assert eng.evaluate(reading(25, 1)) == []

    opened = eng.evaluate(reading(35, 2))
    assert [e.kind for e in opened] == ["opened"]
    assert opened[0].message == "35.0 > 30"
    assert opened[0].severity == "critical"

    # Still hot: no duplicate alert.
    assert eng.evaluate(reading(36, 3)) == []

    resolved = eng.evaluate(reading(24, 4))
    assert [e.kind for e in resolved] == ["resolved"]
    assert resolved[0].key == opened[0].key


def test_rules_only_apply_to_their_sensor_type():
    eng = AlertEngine([HOT])
    assert eng.evaluate(reading(99, 1, sensor_id="h1", type_="humidity")) == []


def test_for_seconds_waits_before_opening():
    eng = AlertEngine([DOOR])
    assert eng.evaluate(reading(1, 100, "d1", "door")) == []
    assert eng.evaluate(reading(1, 130, "d1", "door")) == []
    assert [e.kind for e in eng.evaluate(reading(1, 160, "d1", "door"))] == ["opened"]


def test_short_breach_never_opens_and_resets_timer():
    eng = AlertEngine([DOOR])
    eng.evaluate(reading(1, 1, "d1", "door"))
    eng.evaluate(reading(0, 30, "d1", "door"))  # closed again: timer resets
    assert eng.evaluate(reading(1, 70, "d1", "door")) == []
    assert eng.evaluate(reading(1, 100, "d1", "door")) == []


def test_each_sensor_has_its_own_alert():
    eng = AlertEngine([HOT])
    a = eng.evaluate(reading(40, 1, "t1"))
    b = eng.evaluate(reading(40, 1, "t2"))
    assert a[0].key != b[0].key


def test_offline_alert_opens_after_silence_and_resolves_on_next_reading():
    eng = AlertEngine([], stale_after_seconds=30)
    eng.evaluate(reading(20, 1000))
    assert eng.check_offline(1020) == []
    assert eng.is_online("t1", 1020)

    opened = eng.check_offline(1031)
    assert [(e.kind, e.rule) for e in opened] == [("opened", "sensor_offline")]
    assert not eng.is_online("t1", 1031)
    assert eng.check_offline(1040) == []  # not repeated

    back = eng.evaluate(reading(20, 1050))
    assert [(e.kind, e.rule) for e in back] == [("resolved", "sensor_offline")]


def test_restore_prevents_duplicate_after_restart():
    eng = AlertEngine([HOT])
    eng.restore(["t1:high_temperature"])
    assert eng.evaluate(reading(40, 1)) == []
    assert [e.kind for e in eng.evaluate(reading(20, 2))] == ["resolved"]


def test_shipped_rules_file_loads():
    from app.config import APP_DIR

    eng = AlertEngine.from_yaml(APP_DIR / "rules.yaml")
    assert {r.name for r in eng.rules} >= {"high_temperature", "door_left_open"}
