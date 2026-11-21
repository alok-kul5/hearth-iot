import json

from app.automations import Automations
from app.config import APP_DIR
from app.ingest import Ingestor
from app.models import AlertEvent
from app.rules import AlertEngine, Rule
from app.storage import Storage

CO2 = Rule("co2_high", "co2", ">", 1000, activates=["erv-main"])
PM = Rule("pm25_high", "pm25", ">", 35, activates=["erv-main"])
HOT = Rule("high_temperature", "temperature", ">", 30)


def event(kind, sensor, rule):
    return AlertEvent(kind=kind, key=f"{sensor}:{rule}", rule=rule, sensor_id=sensor, severity="warning",
                      message="", value=None, ts=1)


def recorder():
    sent = []
    return sent, lambda device, state: sent.append((device, state))


def test_device_turns_on_with_the_alert_and_off_when_it_resolves():
    sent, send = recorder()
    a = Automations([CO2, HOT], send)
    assert a.devices == ["erv-main"]
    a.apply(event("opened", "co2-bedroom", "co2_high"))
    assert sent == [("erv-main", "ON")]
    assert a.state() == {"erv-main": {"state": "ON", "because": ["co2-bedroom:co2_high"]}}
    a.apply(event("resolved", "co2-bedroom", "co2_high"))
    assert sent == [("erv-main", "ON"), ("erv-main", "OFF")]


def test_shared_device_stays_on_until_the_last_alert_resolves():
    sent, send = recorder()
    a = Automations([CO2, PM], send)
    a.apply(event("opened", "co2-bedroom", "co2_high"))
    a.apply(event("opened", "pm25-kitchen", "pm25_high"))
    a.apply(event("resolved", "co2-bedroom", "co2_high"))
    assert sent == [("erv-main", "ON")]  # kitchen smoke still needs it
    a.apply(event("resolved", "pm25-kitchen", "pm25_high"))
    assert sent == [("erv-main", "ON"), ("erv-main", "OFF")]


def test_rules_without_actions_send_nothing():
    sent, send = recorder()
    a = Automations([CO2, HOT], send)
    a.apply(event("opened", "temp-kitchen", "high_temperature"))
    assert sent == []


def test_restore_and_sync_after_restart():
    sent, send = recorder()
    a = Automations([CO2], send)
    a.restore(["co2-living:co2_high", "temp-kitchen:high_temperature"])
    assert sent == []
    a.sync()
    assert sent == [("erv-main", "ON")]


def test_ingest_runs_rules_then_automation_end_to_end():
    sent, send = recorder()
    broadcasts = []
    engine = AlertEngine.from_yaml(APP_DIR / "rules.yaml")
    ing = Ingestor(Storage(":memory:"), engine, broadcasts.append, Automations(engine.rules, send))

    def co2(value, ts):
        body = {"sensor_id": "co2-bedroom", "room": "bedroom", "type": "co2", "value": value, "unit": "ppm", "ts": ts}
        ing.handle("home/bedroom/co2-bedroom", json.dumps(body).encode())

    for i in range(7):  # 1150 ppm for six minutes
        co2(1150, 1000 + i * 60)
    assert sent == [("erv-main", "ON")]
    assert any(b["kind"] == "automation" and b["data"]["erv-main"]["state"] == "ON" for b in broadcasts)
    co2(700, 1500)
    assert sent == [("erv-main", "ON"), ("erv-main", "OFF")]
