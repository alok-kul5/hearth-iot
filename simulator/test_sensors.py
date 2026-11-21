import random

from sensors import (
    CO2Sensor,
    DoorSensor,
    Home,
    Household,
    HumiditySensor,
    LeakSensor,
    LightState,
    MotionSensor,
    PM25Sensor,
    TDSSensor,
    TemperatureSensor,
    VentilationState,
    VOCSensor,
    local_hour,
)


def test_home_has_seventeen_sensors_with_unique_ids():
    home = Home()
    ids = [s.sensor_id for s in home.sensors]
    assert len(ids) == 17
    assert len(ids) == len(set(ids))


def test_wellness_sensors_share_one_household():
    home = Home()
    shared = [s for s in home.sensors if hasattr(s, "household")]
    assert len(shared) >= 6
    assert all(s.household is home.household for s in shared)


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


# --- wellness sensors -------------------------------------------------------

NOON = 1_700_000_000 - (1_700_000_000 % 86400) + 12 * 3600  # 12:00 UTC
NIGHT = NOON + 14 * 3600                                     # 02:00 UTC the next day


def run(sensor, t0, ticks, rng, household=None):
    values = []
    for i in range(ticks):
        t = t0 + i * 2
        if household is not None:
            household.step(t, rng)
        values.append(sensor.read(t, rng))
    return values


def test_co2_rises_overnight_in_an_occupied_bedroom():
    rng = random.Random(1)
    h = Household()
    s = CO2Sensor("c", "bedroom", "co2", "ppm", household=h)
    values = run(s, NIGHT, 900, rng)
    assert values[0] < 700
    assert values[-1] > 1100  # two sleepers, windows shut


def test_co2_stays_near_outdoor_level_in_an_empty_room():
    rng = random.Random(2)
    s = CO2Sensor("c", "bedroom", "co2", "ppm", household=Household())
    values = run(s, NOON, 900, rng)  # nobody in the bedroom at noon
    assert all(380 < v < 600 for v in values[-200:])


def test_ventilation_brings_co2_down():
    rng = random.Random(3)
    h = Household()
    s = CO2Sensor("c", "bedroom", "co2", "ppm", household=h)
    high = run(s, NIGHT, 900, rng)[-1]
    h.ventilation = True
    low = run(s, NIGHT + 1800, 300, rng)[-1]
    assert low < high - 400


def test_more_people_means_more_co2():
    a, b = Household(), Household()
    b._guests_left = 10_000  # a party in the living room
    ca = CO2Sensor("c", "living_room", "co2", "ppm", household=a)
    cb = CO2Sensor("c", "living_room", "co2", "ppm", household=b)
    va = run(ca, NOON, 600, random.Random(4))[-1]
    vb = run(cb, NOON, 600, random.Random(4))[-1]
    assert vb > va + 500


def test_pm25_spikes_while_cooking_and_settles_after():
    rng = random.Random(5)
    h = Household()
    s = PM25Sensor("p", "kitchen", "pm25", "µg/m³", household=h)
    quiet = run(s, NOON, 200, rng)
    assert max(quiet) < 15
    h._cooking_left = 150
    cooking = run(s, NOON, 150, rng)
    assert max(cooking) > 35
    h._cooking_left = 0
    after = run(s, NOON, 400, rng)
    assert after[-1] < 15


def test_cooking_happens_at_meal_times():
    rng = random.Random(6)
    h = Household()
    dinner = NOON + 7.5 * 3600  # 19:30 UTC
    started = 0
    for _ in range(2000):
        h.step(dinner, rng)
        if h._cooking_left:
            started += 1
            h._cooking_left = 0
    assert started > 5


def test_voc_spray_spike_decays():
    rng = random.Random(7)
    h = Household()
    s = VOCSensor("v", "living_room", "voc", "ppb", household=h, fault_chance=0)
    base = run(s, NOON, 300, rng)[-1]
    assert base < 300
    s.fault_chance = 1.0
    spike = s.read(NOON, rng)
    s.fault_chance = 0
    assert spike > 500
    later = run(s, NOON, 500, rng)[-1]
    assert later < 300


def test_tds_normal_range_and_filter_breakthrough():
    rng = random.Random(8)
    s = TDSSensor("w", "kitchen", "tds", "ppm", fault_chance=0)
    normal = run(s, NOON, 500, rng)
    assert all(50 < v < 150 for v in normal)
    s.fault_chance = 1.0
    bad = run(s, NOON, 60, rng)
    assert max(bad) > 300


def test_leak_stays_wet_for_a_while():
    rng = random.Random(9)
    s = LeakSensor("l", "bathroom", "leak", "bool", fault_chance=1.0)
    assert all(v == 1.0 for v in run(s, NOON, 30, rng))
    dry = LeakSensor("l", "bathroom", "leak", "bool", fault_chance=0)
    assert set(run(dry, NOON, 500, rng)) == {0.0}


def test_commands_switch_the_erv_and_set_the_light():
    h = Household()
    erv = VentilationState("erv-main", "hallway", "ventilation", "bool", household=h)
    kelvin = LightState("k", "living_room", "color_temp", "K", household=h, attribute="kelvin")
    level = LightState("b", "living_room", "brightness", "%", household=h, attribute="level")
    rng = random.Random(0)
    assert erv.read(0, rng) == 0.0
    assert h.apply_command("erv-main", b"ON")
    assert erv.read(0, rng) == 1.0
    assert h.apply_command("light-living", b'{"color_temp_k": 4000, "brightness": 80}')
    assert (kelvin.read(0, rng), level.read(0, rng)) == (4000, 80)


def test_bad_commands_are_ignored():
    h = Household()
    assert not h.apply_command("erv-main", b"maybe")
    assert not h.apply_command("light-living", b"not json")
    assert not h.apply_command("toaster", b"ON")
    assert h.ventilation is False


def test_light_command_is_clamped():
    h = Household()
    h.apply_command("light-living", b'{"color_temp_k": 99999, "brightness": -5}')
    assert (h.light_kelvin, h.light_level) == (6500, 0)


def test_local_hour_uses_the_home_time_zone():
    from zoneinfo import ZoneInfo

    assert local_hour(NOON) == 12
    assert local_hour(NOON, ZoneInfo("Asia/Kolkata")) == 17.5
