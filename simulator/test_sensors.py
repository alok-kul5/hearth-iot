import random

from sensors import DoorSensor, Home, HumiditySensor, MotionSensor, TemperatureSensor


def test_home_has_between_5_and_10_sensors_with_unique_ids():
    home = Home()
    ids = [s.sensor_id for s in home.sensors]
    assert 5 <= len(ids) <= 10
    assert len(ids) == len(set(ids))


def test_payload_shape_and_topic():
    rng = random.Random(1)
    topic, payload = Home().tick(1_700_000_000, rng)[0]
    assert topic == f"home/{payload['room']}/{payload['sensor_id']}"
    assert set(payload) == {"sensor_id", "room", "type", "value", "unit", "ts"}


def test_temperature_stays_plausible_without_faults():
    rng = random.Random(7)
    s = TemperatureSensor("t", "r", "temperature", "°C", fault_chance=0)
    values = [s.read(i * 2.0, rng) for i in range(5000)]
    assert all(10 < v < 32 for v in values)


def test_temperature_fault_produces_a_spike():
    rng = random.Random(3)
    s = TemperatureSensor("t", "r", "temperature", "°C", fault_chance=1.0)
    assert s.read(0, rng) > 30


def test_humidity_is_clamped_to_percentage():
    rng = random.Random(5)
    s = HumiditySensor("h", "r", "humidity", "%", fault_chance=0.05)
    assert all(0 <= s.read(i, rng) <= 100 for i in range(5000))


def test_binary_sensors_only_emit_zero_or_one():
    rng = random.Random(9)
    for s in (MotionSensor("m", "r", "motion", "bool"), DoorSensor("d", "r", "door", "bool")):
        assert {s.read(i, rng) for i in range(2000)} <= {0.0, 1.0}


def test_door_left_open_stays_open_for_many_ticks():
    rng = random.Random(0)
    s = DoorSensor("d", "r", "door", "bool", open_chance=1.0, left_open_chance=1.0)
    assert all(s.read(i, rng) == 1.0 for i in range(40))


def test_demo_mode_raises_fault_rates():
    from sensors import default_sensors

    normal = {s.sensor_id: s for s in default_sensors()}
    demo = {s.sensor_id: s for s in default_sensors(15)}
    assert demo["temp-kitchen"].fault_chance > normal["temp-kitchen"].fault_chance
    assert demo["door-front"].left_open_chance > normal["door-front"].left_open_chance
