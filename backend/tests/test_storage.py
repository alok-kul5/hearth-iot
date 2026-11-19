from app.models import AlertEvent, Reading
from app.storage import Storage


def r(value, ts, sid="s1"):
    return Reading(sensor_id=sid, room="room", type="temperature", value=value, unit="°C", ts=ts)


def test_latest_value_ignores_out_of_order_readings():
    db = Storage(":memory:")
    db.add_reading(r(20, 200))
    db.add_reading(r(10, 100))  # arrives late
    assert db.sensors()[0]["last_value"] == 20
    assert db.reading_count() == 2


def test_prune_removes_old_readings_only():
    db = Storage(":memory:")
    db.add_reading(r(1, 100))
    db.add_reading(r(2, 500))
    assert db.prune(300) == 1
    assert db.reading_count() == 1


def test_resolving_unknown_alert_is_a_noop():
    db = Storage(":memory:")
    e = AlertEvent(kind="resolved", key="s1:x", rule="x", sensor_id="s1", severity="warning", message="", value=None, ts=1)
    assert db.apply_alert(e) is None


def test_open_alert_keys_round_trip():
    db = Storage(":memory:")
    e = AlertEvent(kind="opened", key="s1:x", rule="x", sensor_id="s1", severity="warning", message="m", value=3, ts=1)
    row = db.apply_alert(e)
    assert row["resolved_at"] is None
    assert db.open_alert_keys() == ["s1:x"]
    db.apply_alert(e.model_copy(update={"kind": "resolved", "ts": 2}))
    assert db.open_alert_keys() == []
