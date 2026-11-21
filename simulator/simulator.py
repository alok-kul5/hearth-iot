"""Publish simulated home sensor readings to an MQTT broker.

Usage:
    python simulator.py --host localhost --port 1883 --interval 2
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import random
import signal
import time
from zoneinfo import ZoneInfo

import paho.mqtt.client as mqtt

from sensors import Home, Household, default_sensors

log = logging.getLogger("simulator")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--host", default=os.getenv("MQTT_HOST", "localhost"))
    p.add_argument("--port", type=int, default=int(os.getenv("MQTT_PORT", "1883")))
    p.add_argument("--interval", type=float, default=float(os.getenv("PUBLISH_INTERVAL", "2")))
    p.add_argument("--seed", type=int, default=None, help="random seed for repeatable runs")
    p.add_argument("--demo", action="store_true", help="make faults ~15x more frequent so alerts show up quickly")
    p.add_argument("--count", type=int, default=0, help="stop after N ticks (0 = run forever)")
    p.add_argument("--timezone", default=os.getenv("TIMEZONE", "UTC"), help="home time zone, e.g. Asia/Kolkata")
    return p.parse_args()


COMMAND_TOPIC = "hearth/cmd/+"


def connect(host: str, port: int, household: Household) -> mqtt.Client:
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="home-simulator")
    client.enable_logger(log)

    # Devices (the ERV and the circadian light) take commands from the backend or Home Assistant.
    def on_connect(c, userdata, flags, reason_code, properties):
        if not reason_code.is_failure:
            c.subscribe(COMMAND_TOPIC, qos=1)

    def on_message(c, userdata, msg):
        device = msg.topic.rsplit("/", 1)[-1]
        if household.apply_command(device, msg.payload):
            log.info("command %s <- %s", device, msg.payload.decode(errors="replace"))
        else:
            log.warning("ignored command on %s: %r", msg.topic, msg.payload[:80])

    client.on_connect = on_connect
    client.on_message = on_message
    # The broker may still be starting when the container comes up, so retry.
    for attempt in range(1, 31):
        try:
            client.connect(host, port, keepalive=30)
            break
        except OSError as exc:
            log.warning("broker not reachable (%s), retry %d/30", exc, attempt)
            time.sleep(2)
    else:
        raise SystemExit(f"could not connect to MQTT broker at {host}:{port}")
    client.loop_start()
    return client


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    rng = random.Random(args.seed)
    household = Household(tz=ZoneInfo(args.timezone))
    home = Home(default_sensors(15.0 if args.demo else 1.0, household), household)
    client = connect(args.host, args.port, household)
    log.info("publishing %d sensors to %s:%d every %.1fs", len(home.sensors), args.host, args.port, args.interval)

    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    ticks = 0
    while running:
        now = time.time()
        for topic, payload in home.tick(now, rng):
            client.publish(topic, json.dumps(payload), qos=1)
        ticks += 1
        if args.count and ticks >= args.count:
            break
        time.sleep(args.interval)

    client.loop_stop()
    client.disconnect()
    log.info("stopped after %d ticks", ticks)


if __name__ == "__main__":
    main()
