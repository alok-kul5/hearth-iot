import json
from typing import get_args

import pytest

from app.ha_discovery import AVAILABILITY_TOPIC, TYPES, Discovery, discovery_message
from app.models import SensorType

ALL_SENSORS = [
    ("temp-living", "living_room", "temperature"),
    ("hum-living", "living_room", "humidity"),
    ("co2-living", "living_room", "co2"),
    ("voc-living", "living_room", "voc"),
    ("light-living-kelvin", "living_room", "color_temp"),
    ("light-living-level", "living_room", "brightness"),
    ("temp-bedroom", "bedroom", "temperature"),
    ("co2-bedroom", "bedroom", "co2"),
    ("hum-bathroom", "bathroom", "humidity"),
    ("leak-bathroom", "bathroom", "leak"),
    ("temp-kitchen", "kitchen", "temperature"),
    ("pm25-kitchen", "kitchen", "pm25"),
    ("tds-kitchen", "kitchen", "tds"),
    ("motion-hallway", "hallway", "motion"),
    ("erv-main", "hallway", "ventilation"),
    ("door-front", "entrance", "door"),
    ("door-back", "kitchen", "door"),
]


def sensor(sid, room, type_):
    return {"sensor_id": sid, "room": room, "type": type_, "unit": ""}


def test_every_sensor_type_the_backend_accepts_has_a_mapping():
    assert set(get_args(SensorType)) == set(TYPES)


@pytest.mark.parametrize("sid,room,type_", ALL_SENSORS)
def test_every_hearth_sensor_gets_a_valid_config(sid, room, type_):
    topic, cfg = discovery_message(sensor(sid, room, type_))
    component = topic.split("/")[1]
    assert topic == f"homeassistant/{component}/hearth/{sid}/config"
    assert component in {"sensor", "binary_sensor", "switch"}
    assert cfg["unique_id"] == f"hearth_{sid}"
    assert cfg["state_topic"] == f"home/{room}/{sid}"
    assert cfg["availability_topic"] == AVAILABILITY_TOPIC
    assert cfg["device"]["identifiers"] == [f"hearth_{room}"]
    assert cfg["value_template"]
    json.dumps(cfg)


def test_unique_ids_and_topics_are_unique():
    msgs = [discovery_message(sensor(*s)) for s in ALL_SENSORS]
    assert len({t for t, _ in msgs}) == len(msgs)
    assert len({c["unique_id"] for _, c in msgs}) == len(msgs)


def test_co2_sensor_config():
    topic, cfg = discovery_message(sensor("co2-bedroom", "bedroom", "co2"))
    assert topic == "homeassistant/sensor/hearth/co2-bedroom/config"
    assert cfg["device_class"] == "carbon_dioxide"
    assert cfg["unit_of_measurement"] == "ppm"
    assert cfg["state_class"] == "measurement"
    assert cfg["value_template"] == "{{ value_json.value }}"
    assert cfg["expire_after"] == 30
    assert cfg["device"]["suggested_area"] == "Bedroom"


def test_pm25_uses_the_unit_home_assistant_expects():
    _, cfg = discovery_message(sensor("pm25-kitchen", "kitchen", "pm25"))
    assert cfg["device_class"] == "pm25"
    assert cfg["unit_of_measurement"] == "μg/m³"  # Greek mu, as in HA's constants


def test_voc_uses_the_parts_device_class():
    _, cfg = discovery_message(sensor("voc-living", "living_room", "voc"))
    assert (cfg["device_class"], cfg["unit_of_measurement"]) == ("volatile_organic_compounds_parts", "ppb")


def test_leak_is_a_moisture_binary_sensor():
    topic, cfg = discovery_message(sensor("leak-bathroom", "bathroom", "leak"))
    assert topic.startswith("homeassistant/binary_sensor/")
    assert cfg["device_class"] == "moisture"
    assert (cfg["payload_on"], cfg["payload_off"]) == ("ON", "OFF")


def test_binary_value_template_maps_readings_to_on_off():
    jinja2 = pytest.importorskip("jinja2")
    _, cfg = discovery_message(sensor("door-front", "entrance", "door"))
    tpl = jinja2.Template(cfg["value_template"])
    assert tpl.render(value_json={"value": 1.0}) == "ON"
    assert tpl.render(value_json={"value": 0.0}) == "OFF"


def test_ventilation_is_a_switch_home_assistant_can_control():
    topic, cfg = discovery_message(sensor("erv-main", "hallway", "ventilation"))
    assert topic == "homeassistant/switch/hearth/erv-main/config"
    assert cfg["command_topic"] == "hearth/cmd/erv-main"
    assert (cfg["payload_on"], cfg["payload_off"]) == ("ON", "OFF")
    assert "expire_after" not in cfg  # not supported for switches


def test_unknown_type_is_skipped():
    assert discovery_message(sensor("x", "r", "lava")) is None


def test_custom_prefix():
    topic, _ = discovery_message(sensor("co2-living", "living_room", "co2"), prefix="ha")
    assert topic.startswith("ha/sensor/")


def test_discovery_announces_each_sensor_once_and_retains():
    published = []
    d = Discovery(lambda topic, payload, retain: published.append((topic, json.loads(payload), retain)))
    s = sensor("co2-living", "living_room", "co2")
    d.on_reading(s)
    d.on_reading(s)
    assert len(published) == 1
    assert published[0][2] is True
    assert d.announce_all([sensor(*x) for x in ALL_SENSORS]) == 17
    assert len(published) == 18
