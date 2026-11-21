"""End-to-end check against a running stack (used by CI after `docker compose up`).

Waits until every simulated sensor has reported through MQTT into the backend,
then checks the history endpoint and the dashboard page.

    python scripts/smoke_test.py --url http://localhost:8000 --sensors 17
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request


def get(url: str):
    with urllib.request.urlopen(url, timeout=5) as r:
        body = r.read().decode()
        return json.loads(body) if r.headers.get_content_type() == "application/json" else body


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:8000")
    p.add_argument("--sensors", type=int, default=17)
    p.add_argument("--timeout", type=float, default=90)
    a = p.parse_args()

    deadline = time.time() + a.timeout
    sensors: list = []
    while time.time() < deadline:
        try:
            health = get(f"{a.url}/api/health")
            sensors = get(f"{a.url}/api/sensors")
            print(f"mqtt_connected={health['mqtt_connected']} stored={health['readings_stored']} sensors={len(sensors)}")
            if health["mqtt_connected"] and len(sensors) >= a.sensors:
                break
        except OSError as exc:
            print(f"waiting for backend: {exc}")
        time.sleep(3)
    else:
        print(f"FAIL: expected {a.sensors} sensors, saw {len(sensors)}")
        return 1

    assert all(s["online"] for s in sensors), "a sensor is offline"
    hist = get(f"{a.url}/api/sensors/{sensors[0]['sensor_id']}/history?minutes=5")
    assert hist, "history is empty"
    assert "Hearth" in get(f"{a.url}/"), "dashboard page missing"
    discovery = get(f"{a.url}/api/homeassistant/discovery")
    assert len(discovery) == len(sensors), "a sensor has no Home Assistant discovery config"
    assert "erv-main" in get(f"{a.url}/api/automations"), "ventilation automation missing"
    assert get(f"{a.url}/api/circadian")["schedule"], "circadian schedule missing"
    print(f"OK: {len(sensors)} sensors live, {len(hist)} history points for {sensors[0]['sensor_id']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
