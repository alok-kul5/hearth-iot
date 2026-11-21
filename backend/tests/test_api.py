import json
import time

import pytest
from fastapi.testclient import TestClient

from app.config import APP_DIR, Settings
from app.main import create_app


@pytest.fixture
def client(tmp_path):
    cfg = Settings(db_path=str(tmp_path / "test.db"), rules_path=str(APP_DIR / "rules.yaml"), enable_mqtt=False)
    app = create_app(cfg)
    with TestClient(app) as c:
        c.ingest = app.state.ingestor.handle
        yield c


def msg(sensor_id="temp-kitchen", value=22.0, ts=None, type_="temperature", room="kitchen"):
    payload = {"sensor_id": sensor_id, "room": room, "type": type_, "value": value, "unit": "°C", "ts": ts or time.time()}
    return f"home/{room}/{sensor_id}", json.dumps(payload).encode()


def test_health(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["mqtt_connected"] is False


def test_reading_is_stored_and_listed(client):
    client.ingest(*msg(value=21.5))
    sensors = client.get("/api/sensors").json()
    assert len(sensors) == 1
    assert sensors[0]["sensor_id"] == "temp-kitchen"
    assert sensors[0]["last_value"] == 21.5
    assert sensors[0]["online"] is True


def test_history_returns_points_in_window(client):
    now = time.time()
    for i in range(10):
        client.ingest(*msg(value=20 + i, ts=now - 100 + i * 10))
    client.ingest(*msg(value=99, ts=now - 3600))  # outside a 5 minute window
    pts = client.get("/api/sensors/temp-kitchen/history?minutes=5").json()
    assert len(pts) == 10
    assert pts[0]["value"] == 20


def test_history_is_downsampled_for_large_windows(client):
    now = time.time()
    for i in range(1200):
        client.ingest(*msg(value=i % 7, ts=now - 1200 + i))
    pts = client.get("/api/sensors/temp-kitchen/history?minutes=30").json()
    assert 0 < len(pts) <= 301


def test_unknown_sensor_history_is_404(client):
    assert client.get("/api/sensors/nope/history").status_code == 404


def test_threshold_breach_creates_and_resolves_alert(client):
    now = time.time()
    client.ingest(*msg(value=35, ts=now - 2))
    active = client.get("/api/alerts?active=true").json()
    assert len(active) == 1
    assert active[0]["rule"] == "high_temperature"
    assert active[0]["severity"] == "critical"

    client.ingest(*msg(value=22, ts=now - 1))
    assert client.get("/api/alerts?active=true").json() == []
    history = client.get("/api/alerts").json()
    assert history[0]["resolved_at"] is not None


@pytest.mark.parametrize(
    "topic,payload",
    [
        ("home/kitchen/x", b"not json"),
        ("home/kitchen/x", b'{"sensor_id": "x"}'),
        ("home/kitchen/x", json.dumps({"sensor_id": "x", "room": "k", "type": "lava", "value": 1, "unit": "", "ts": 1}).encode()),
        ("home/kitchen/other", msg(sensor_id="x")[1]),  # topic / payload mismatch
    ],
)
def test_bad_messages_are_rejected_not_stored(client, topic, payload):
    client.ingest(topic, payload)
    assert client.get("/api/sensors").json() == []
    assert client.get("/api/health").json()["messages_rejected"] == 1


def test_websocket_receives_live_readings(client):
    with client.websocket_connect("/ws") as ws:
        client.ingest(*msg(value=23.0))
        data = json.loads(ws.receive_text())
        assert data["kind"] == "reading"
        assert data["data"]["value"] == 23.0


def test_dashboard_page_is_served(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Hearth" in r.text
    assert client.get("/static/app.js").status_code == 200


def test_rules_endpoint(client):
    body = client.get("/api/rules").json()
    assert body["stale_after_seconds"] == 30
    assert any(r["name"] == "door_left_open" for r in body["rules"])


def test_wellness_readings_are_accepted(client):
    for sid, room, type_, value in [
        ("co2-bedroom", "bedroom", "co2", 640), ("pm25-kitchen", "kitchen", "pm25", 8.2),
        ("voc-living", "living_room", "voc", 140), ("tds-kitchen", "kitchen", "tds", 85),
        ("leak-bathroom", "bathroom", "leak", 0), ("erv-main", "hallway", "ventilation", 0),
        ("light-living-kelvin", "living_room", "color_temp", 4000), ("light-living-level", "living_room", "brightness", 80),
    ]:
        client.ingest(*msg(sensor_id=sid, room=room, type_=type_, value=value))
    assert len(client.get("/api/sensors").json()) == 8
    assert client.get("/api/health").json()["messages_rejected"] == 0


def test_leak_raises_a_critical_alert(client):
    client.ingest(*msg(sensor_id="leak-bathroom", room="bathroom", type_="leak", value=1))
    active = client.get("/api/alerts?active=true").json()
    assert [(a["rule"], a["severity"]) for a in active] == [("water_leak", "critical")]


def test_high_co2_switches_ventilation_on(client):
    assert client.get("/api/automations").json() == {"erv-main": {"state": "OFF", "because": []}}
    now = time.time()
    for i in range(7):
        client.ingest(*msg(sensor_id="co2-bedroom", room="bedroom", type_="co2", value=1180, ts=now - 360 + i * 60))
    state = client.get("/api/automations").json()["erv-main"]
    assert state == {"state": "ON", "because": ["co2-bedroom:co2_high"]}


def test_circadian_endpoint(client):
    body = client.get("/api/circadian").json()
    assert body["timezone"] == "UTC"
    assert 0 <= body["hour"] < 24
    assert len(body["schedule"]) == 49
    assert 1800 <= body["target"]["kelvin"] <= 6500


def test_home_assistant_discovery_endpoint_lists_known_sensors(client):
    client.ingest(*msg())
    client.ingest(*msg(sensor_id="co2-bedroom", room="bedroom", type_="co2", value=600))
    body = client.get("/api/homeassistant/discovery").json()
    topics = sorted(m["topic"] for m in body)
    assert topics == ["homeassistant/sensor/hearth/co2-bedroom/config", "homeassistant/sensor/hearth/temp-kitchen/config"]


def test_home_assistant_birth_message_resends_discovery(client, monkeypatch):
    sent = []
    disc = client.app.state.discovery
    monkeypatch.setattr(disc, "publish", lambda topic, payload, retain: sent.append(topic))
    client.ingest(*msg())
    assert len(sent) == 1  # first reading announces the sensor
    client.app.state.on_message("homeassistant/status", b"online")
    assert len(sent) == 2
    assert client.get("/api/health").json()["messages_rejected"] == 0  # not treated as a reading
