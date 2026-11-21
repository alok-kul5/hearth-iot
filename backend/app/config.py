"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Settings:
    mqtt_host: str = os.getenv("MQTT_HOST", "localhost")
    mqtt_port: int = int(os.getenv("MQTT_PORT", "1883"))
    mqtt_topic: str = os.getenv("MQTT_TOPIC", "home/#")
    db_path: str = os.getenv("DB_PATH", "data/readings.db")
    rules_path: str = os.getenv("RULES_PATH", str(APP_DIR / "rules.yaml"))
    retention_hours: float = float(os.getenv("RETENTION_HOURS", "24"))
    enable_mqtt: bool = os.getenv("ENABLE_MQTT", "1") == "1"
    timezone: str = os.getenv("TIMEZONE", "UTC")
    ha_discovery: bool = os.getenv("HA_DISCOVERY", "1") == "1"
    ha_prefix: str = os.getenv("HA_DISCOVERY_PREFIX", "homeassistant")
    circadian: bool = os.getenv("CIRCADIAN", "1") == "1"
    sim_controls: bool = os.getenv("SIMULATOR_CONTROLS", "1") == "1"  # the dashboard's "Try it" buttons


settings = Settings()
