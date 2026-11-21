"""Home Assistant MQTT Discovery.

For every sensor Hearth sees, the backend publishes a retained config message to
`homeassistant/<component>/hearth/<sensor_id>/config`. Home Assistant's MQTT
integration reads these and creates the entities on its own, grouped into one
device per room. The entities read the same `home/{room}/{sensor_id}` topics
the dashboard uses, so nothing else has to change. The configs are sent again
whenever Home Assistant announces it has (re)started (`homeassistant/status`
= `online`).

Reference: https://www.home-assistant.io/integrations/mqtt/#mqtt-discovery
"""

from __future__ import annotations

import json
from collections.abc import Callable

AVAILABILITY_TOPIC = "hearth/status"
COMMAND_PREFIX = "hearth/cmd"
STALE_AFTER = 30  # seconds without a reading before HA shows the entity as unavailable

BINARY = "{{ 'ON' if value_json.value == 1 else 'OFF' }}"

# sensor type -> (component, entity name, extra config). Units are spelled the way HA expects
# (PM2.5 uses the Greek letter mu, U+03BC), otherwise HA rejects the unit for that device class.
TYPES: dict[str, tuple[str, str, dict]] = {
    "temperature": ("sensor", "Temperature", {"device_class": "temperature", "unit_of_measurement": "°C"}),
    "humidity": ("sensor", "Humidity", {"device_class": "humidity", "unit_of_measurement": "%"}),
    "co2": ("sensor", "CO2", {"device_class": "carbon_dioxide", "unit_of_measurement": "ppm"}),
    "pm25": ("sensor", "PM2.5", {"device_class": "pm25", "unit_of_measurement": "μg/m³"}),
    "voc": ("sensor", "VOC", {"device_class": "volatile_organic_compounds_parts", "unit_of_measurement": "ppb"}),
    "tds": ("sensor", "Water TDS", {"unit_of_measurement": "ppm", "icon": "mdi:water-check"}),
    "color_temp": ("sensor", "Light colour temperature", {"unit_of_measurement": "K", "icon": "mdi:white-balance-sunny"}),
    "brightness": ("sensor", "Light brightness", {"unit_of_measurement": "%", "icon": "mdi:brightness-6"}),
    "motion": ("binary_sensor", "Motion", {"device_class": "motion"}),
    "door": ("binary_sensor", "Door", {"device_class": "door"}),
    "leak": ("binary_sensor", "Leak", {"device_class": "moisture"}),
    "ventilation": ("switch", "Ventilation", {"icon": "mdi:hvac"}),
}


def room_label(room: str) -> str:
    return room.replace("_", " ").capitalize()


def discovery_message(sensor: dict, prefix: str = "homeassistant") -> tuple[str, dict] | None:
    """(topic, config) announcing one Hearth sensor to Home Assistant, or None for an unknown type.

    `sensor` needs `sensor_id`, `room` and `type`, as stored by the backend.
    """
    kind = TYPES.get(sensor["type"])
    if kind is None:
        return None
    component, name, extra = kind
    sid, room = sensor["sensor_id"], sensor["room"]
    cfg: dict = {
        "name": name,
        "unique_id": f"hearth_{sid}",
        "state_topic": f"home/{room}/{sid}",
        "availability_topic": AVAILABILITY_TOPIC,
        "device": {
            "identifiers": [f"hearth_{room}"],
            "name": f"Hearth {room_label(room)}",
            "manufacturer": "Hearth",
            "model": "Simulated sensors",
            "suggested_area": room_label(room),
        },
        "origin": {"name": "Hearth", "support_url": "https://github.com/alok-kul5/hearth-iot"},
        **extra,
    }
    if component == "sensor":
        cfg |= {"value_template": "{{ value_json.value }}", "state_class": "measurement", "expire_after": STALE_AFTER}
    elif component == "binary_sensor":
        cfg |= {"value_template": BINARY, "payload_on": "ON", "payload_off": "OFF", "expire_after": STALE_AFTER}
    else:  # switch: HA can turn the device on and off itself
        cfg |= {
            "value_template": BINARY,
            "state_on": "ON",
            "state_off": "OFF",
            "command_topic": f"{COMMAND_PREFIX}/{sid}",
            "payload_on": "ON",
            "payload_off": "OFF",
        }
    return f"{prefix}/{component}/hearth/{sid}/config", cfg


Publish = Callable[[str, str, bool], None]  # (topic, payload, retain)


class Discovery:
    """Publishes a discovery config the first time each sensor is seen, and all of them on request."""

    def __init__(self, publish: Publish, prefix: str = "homeassistant") -> None:
        self.publish = publish
        self.prefix = prefix
        self.announced: set[str] = set()

    @property
    def status_topic(self) -> str:
        return f"{self.prefix}/status"

    def announce(self, sensor: dict) -> bool:
        msg = discovery_message(sensor, self.prefix)
        if msg is None:
            return False
        topic, cfg = msg
        self.publish(topic, json.dumps(cfg, ensure_ascii=False), True)
        self.announced.add(sensor["sensor_id"])
        return True

    def on_reading(self, sensor: dict) -> None:
        if sensor["sensor_id"] not in self.announced:
            self.announce(sensor)

    def announce_all(self, sensors: list[dict]) -> int:
        return sum(self.announce(s) for s in sensors)
