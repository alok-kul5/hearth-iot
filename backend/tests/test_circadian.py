import json
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.circadian import KEYFRAMES, CircadianLight, schedule, setpoint


def test_keyframes_cover_the_day_in_order():
    hours = [k[0] for k in KEYFRAMES]
    assert hours[0] == 0 and hours[-1] == 24
    assert hours == sorted(hours)


@pytest.mark.parametrize(
    "hour,kelvin,brightness",
    [(0, 1800, 3), (3, 1800, 3), (12, 5500, 100), (20, 2700, 60), (23, 1800, 5)],
)
def test_setpoint_hits_the_keyframes(hour, kelvin, brightness):
    assert setpoint(hour) == (kelvin, brightness)


def test_setpoint_fades_between_keyframes():
    # Halfway between 08:00 (4000 K, 80 %) and 12:00 (5500 K, 100 %).
    assert setpoint(10) == (4750, 90)


def test_midday_is_cooler_and_brighter_than_evening_and_night():
    noon, evening, night = setpoint(12.5), setpoint(21), setpoint(2)
    assert noon[0] > evening[0] > night[0]
    assert noon[1] > evening[1] > night[1]


def test_evening_light_is_warm():
    for hour in (20, 21, 22, 23):
        assert setpoint(hour)[0] <= 2700


def test_values_stay_in_range_all_day():
    for p in schedule(5):
        assert 1800 <= p["kelvin"] <= 6500
        assert 0 <= p["brightness"] <= 100
        assert p["kelvin"] % 50 == 0


def test_schedule_wraps_around_midnight():
    s = schedule(30)
    assert len(s) == 49
    assert s[0]["kelvin"] == s[-1]["kelvin"]


def test_light_only_sends_when_the_setpoint_changes():
    tz = ZoneInfo("Asia/Kolkata")
    light = CircadianLight(tz)
    t = datetime(2026, 11, 22, 12, 0, tzinfo=tz).timestamp()
    assert json.loads(light.tick(t)) == {"color_temp_k": 5500, "brightness": 100}
    assert light.tick(t + 1) is None
    assert light.tick(t + 1, force=True) is not None
    assert light.tick(t + 3 * 3600) is not None  # 15:00, a different setpoint


def test_light_follows_the_home_time_zone():
    t = datetime(2026, 11, 22, 12, 0, tzinfo=ZoneInfo("UTC")).timestamp()  # 17:30 in India
    assert CircadianLight(ZoneInfo("UTC")).target(t) == setpoint(12)
    assert CircadianLight(ZoneInfo("Asia/Kolkata")).target(t) == setpoint(17.5)
