"""Simulated home sensors.

Each sensor produces plausible readings: temperatures follow a daily curve plus a
random walk, humidity drifts slowly, motion fires as random events, and doors
open and close. A small chance of a fault (heat spike, humidity surge, a door
left open) is built in so the dashboard's threshold alerts have something to catch.

The wellness sensors share one `Household`, so they react to the same events:
CO2 rises with the number of people in a room, cooking sends PM2.5 and VOCs up
in the kitchen and living room, and the ventilation unit (ERV) pulls all of
them back down when the backend switches it on. Time is compressed so changes
that take an hour in a real flat play out over a few minutes.
"""

from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, tzinfo

MEALS = ((7.0, 8.5), (12.5, 14.0), (19.0, 21.0))  # local hours when cooking is likely
OUTDOOR_CO2 = 420.0


def local_hour(t: float, tz: tzinfo = UTC) -> float:
    d = datetime.fromtimestamp(t, tz)
    return d.hour + d.minute / 60 + d.second / 3600


@dataclass
class Household:
    """What is going on in the home right now: people, cooking, ventilation, the light."""

    tz: tzinfo = UTC
    event_scale: float = 1.0          # >1 makes cooking, guests and faults more frequent (--demo)
    ventilation: bool = False         # the ERV, switched by MQTT commands
    light_kelvin: float = 2700.0      # the circadian light, set by MQTT commands
    light_level: float = 0.0
    _cooking_left: int = 0
    _guests_left: int = 0

    @property
    def cooking(self) -> bool:
        return self._cooking_left > 0

    def occupants(self, room: str, hour: float) -> int:
        asleep = hour >= 23 or hour < 7
        guests = 4 if self._guests_left > 0 else 0
        if room == "bedroom":
            return 2 if asleep else 0
        if room == "living_room":
            return 0 if asleep else (3 if hour >= 18 else 1) + guests
        if room == "kitchen":
            return 1 if self.cooking else 0
        return 0

    def step(self, t: float, rng: random.Random) -> None:
        hour = local_hour(t, self.tz)
        if self._cooking_left > 0:
            self._cooking_left -= 1
        else:
            chance = 0.01 if any(a <= hour < b for a, b in MEALS) else 0.0005
            if rng.random() < min(1.0, chance * self.event_scale):
                self._cooking_left = rng.randint(60, 240)
        if self._guests_left > 0:
            self._guests_left -= 1
        elif 9 <= hour < 23 and rng.random() < min(1.0, 0.0008 * self.event_scale):
            self._guests_left = rng.randint(150, 400)

    def apply_command(self, device: str, payload: bytes) -> bool:
        """Apply an MQTT command from `hearth/cmd/{device}`. Returns False if it was not understood."""
        text = payload.decode(errors="replace").strip()
        if device == "erv-main" and text.upper() in ("ON", "OFF"):
            self.ventilation = text.upper() == "ON"
            return True
        if device == "light-living":
            try:
                cmd = json.loads(text)
                self.light_kelvin = float(min(6500, max(1500, cmd["color_temp_k"])))
                self.light_level = float(min(100, max(0, cmd["brightness"])))
            except (ValueError, KeyError, TypeError):
                return False
            return True
        return False


@dataclass
class Sensor:
    sensor_id: str
    room: str
    type: str
    unit: str

    def read(self, t: float, rng: random.Random) -> float:  # pragma: no cover - abstract
        raise NotImplementedError

    def payload(self, t: float, rng: random.Random) -> dict:
        return {
            "sensor_id": self.sensor_id,
            "room": self.room,
            "type": self.type,
            "value": self.read(t, rng),
            "unit": self.unit,
            "ts": t,
        }

    @property
    def topic(self) -> str:
        return f"home/{self.room}/{self.sensor_id}"


@dataclass
class TemperatureSensor(Sensor):
    base: float = 21.0
    amplitude: float = 2.0
    fault_chance: float = 0.002
    _drift: float = 0.0
    _fault_left: int = 0

    def read(self, t: float, rng: random.Random) -> float:
        # Daily cycle: warmest mid-afternoon, coolest before dawn.
        hour = (t / 3600.0) % 24
        daily = self.amplitude * math.sin((hour - 9) / 24 * 2 * math.pi)
        self._drift = max(-1.5, min(1.5, self._drift + rng.gauss(0, 0.05)))
        value = self.base + daily + self._drift + rng.gauss(0, 0.1)
        if self._fault_left == 0 and rng.random() < self.fault_chance:
            self._fault_left = rng.randint(8, 20)  # e.g. oven left on, heater stuck
        if self._fault_left > 0:
            self._fault_left -= 1
            value += 12.0
        return round(value, 2)


@dataclass
class HumiditySensor(Sensor):
    base: float = 45.0
    fault_chance: float = 0.002
    _level: float | None = None
    _fault_left: int = 0

    def read(self, t: float, rng: random.Random) -> float:
        if self._level is None:
            self._level = self.base
        # Mean-reverting walk around the base level.
        self._level += (self.base - self._level) * 0.05 + rng.gauss(0, 0.6)
        value = self._level
        if self._fault_left == 0 and rng.random() < self.fault_chance:
            self._fault_left = rng.randint(8, 20)  # e.g. a long hot shower
        if self._fault_left > 0:
            self._fault_left -= 1
            value += 30.0
        return round(max(0.0, min(100.0, value)), 1)


@dataclass
class MotionSensor(Sensor):
    """1.0 while motion is detected, 0.0 otherwise."""

    trigger_chance: float = 0.08
    _active_left: int = 0

    def read(self, t: float, rng: random.Random) -> float:
        if self._active_left > 0:
            self._active_left -= 1
            return 1.0
        if rng.random() < self.trigger_chance:
            self._active_left = rng.randint(1, 4)
            return 1.0
        return 0.0


@dataclass
class DoorSensor(Sensor):
    """1.0 when the door is open, 0.0 when closed."""

    open_chance: float = 0.03
    left_open_chance: float = 0.05
    _open_left: int = 0

    def read(self, t: float, rng: random.Random) -> float:
        if self._open_left > 0:
            self._open_left -= 1
            return 1.0
        if rng.random() < self.open_chance:
            # Usually a quick in-and-out; sometimes someone forgets to close it.
            long = rng.random() < self.left_open_chance
            self._open_left = rng.randint(40, 80) if long else rng.randint(1, 3)
            return 1.0
        return 0.0


# --- wellness sensors -------------------------------------------------------


@dataclass
class CO2Sensor(Sensor):
    """CO2 in ppm: each person in the room adds CO2, air exchange pulls it back towards outdoor level."""

    household: Household = field(default_factory=Household)
    per_person: float = 1.0      # ppm added per person per tick
    air_exchange: float = 0.002  # share of the gap to outdoor air removed per tick, windows shut
    erv_exchange: float = 0.02   # extra exchange while the ERV runs
    _level: float | None = None

    def read(self, t: float, rng: random.Random) -> float:
        h = self.household
        if self._level is None:
            self._level = OUTDOOR_CO2 + 150
        people = h.occupants(self.room, local_hour(t, h.tz))
        k = self.air_exchange + (self.erv_exchange if h.ventilation else 0.0)
        self._level += people * self.per_person - (self._level - OUTDOOR_CO2) * k + rng.gauss(0, 2)
        self._level = max(OUTDOOR_CO2 - 20, self._level)
        return float(round(self._level))


@dataclass
class PM25Sensor(Sensor):
    """Fine particles (PM2.5) in µg/m³: low background, sharp spikes while someone is cooking."""

    household: Household = field(default_factory=Household)
    base: float = 7.0
    _level: float | None = None

    def read(self, t: float, rng: random.Random) -> float:
        h = self.household
        if self._level is None:
            self._level = self.base
        decay = 0.02 + (0.05 if h.ventilation else 0.0)
        self._level += (self.base - self._level) * decay + rng.gauss(0, 0.3)
        if h.cooking:
            self._level += rng.uniform(0.5, 2.5)  # frying and searing put out the most
        self._level = max(1.0, self._level)
        return round(self._level, 1)


@dataclass
class VOCSensor(Sensor):
    """Total VOCs in ppb: people and cooking add a little, a cleaning spray adds a lot at once."""

    household: Household = field(default_factory=Household)
    base: float = 110.0
    fault_chance: float = 0.001  # a cleaning spray or fresh paint
    _level: float | None = None

    def read(self, t: float, rng: random.Random) -> float:
        h = self.household
        if self._level is None:
            self._level = self.base
        people = h.occupants(self.room, local_hour(t, h.tz))
        target = self.base + 35 * people + (180 if h.cooking else 0)
        decay = 0.01 + (0.03 if h.ventilation else 0.0)
        self._level += (target - self._level) * decay + rng.gauss(0, 4)
        if rng.random() < self.fault_chance:
            self._level += rng.uniform(500, 900)
        self._level = max(20.0, self._level)
        return float(round(self._level))


@dataclass
class TDSSensor(Sensor):
    """Total dissolved solids in the filtered drinking water, ppm. A worn-out filter lets it climb."""

    base: float = 85.0
    fault_chance: float = 0.001
    _level: float | None = None
    _fault_left: int = 0

    def read(self, t: float, rng: random.Random) -> float:
        if self._level is None:
            self._level = self.base
        if self._fault_left == 0 and rng.random() < self.fault_chance:
            self._fault_left = rng.randint(60, 150)  # filter breakthrough
        target = 380.0 if self._fault_left > 0 else self.base
        if self._fault_left > 0:
            self._fault_left -= 1
        self._level += (target - self._level) * 0.08 + rng.gauss(0, 1.5)
        return float(round(max(0.0, self._level)))


@dataclass
class LeakSensor(Sensor):
    """1.0 while water is detected under the sink, 0.0 when dry. A leak stays wet until someone deals with it."""

    fault_chance: float = 0.0005
    _wet_left: int = 0

    def read(self, t: float, rng: random.Random) -> float:
        if self._wet_left == 0 and rng.random() < self.fault_chance:
            self._wet_left = rng.randint(30, 120)
        if self._wet_left > 0:
            self._wet_left -= 1
            return 1.0
        return 0.0


@dataclass
class VentilationState(Sensor):
    """Reports whether the ERV is running (1.0) or off (0.0)."""

    household: Household = field(default_factory=Household)

    def read(self, t: float, rng: random.Random) -> float:
        return 1.0 if self.household.ventilation else 0.0


@dataclass
class LightState(Sensor):
    """Reports the circadian light's colour temperature (K) or brightness (%)."""

    household: Household = field(default_factory=Household)
    attribute: str = "kelvin"

    def read(self, t: float, rng: random.Random) -> float:
        h = self.household
        return round(h.light_kelvin if self.attribute == "kelvin" else h.light_level, 0)


def default_sensors(fault_scale: float = 1.0, household: Household | None = None) -> list[Sensor]:
    """The seventeen sensors of the simulated home.

    `fault_scale` multiplies how often faults and events happen (used by --demo).
    """
    f = fault_scale
    h = household or Household()
    h.event_scale = f
    sensors: list[Sensor] = [
        TemperatureSensor("temp-living", "living_room", "temperature", "°C", base=21.5),
        HumiditySensor("hum-living", "living_room", "humidity", "%", base=45),
        CO2Sensor("co2-living", "living_room", "co2", "ppm", household=h),
        VOCSensor("voc-living", "living_room", "voc", "ppb", household=h),
        LightState("light-living-kelvin", "living_room", "color_temp", "K", household=h, attribute="kelvin"),
        LightState("light-living-level", "living_room", "brightness", "%", household=h, attribute="level"),
        TemperatureSensor("temp-bedroom", "bedroom", "temperature", "°C", base=19.5, amplitude=1.5),
        CO2Sensor("co2-bedroom", "bedroom", "co2", "ppm", household=h),
        HumiditySensor("hum-bathroom", "bathroom", "humidity", "%", base=55),
        LeakSensor("leak-bathroom", "bathroom", "leak", "bool"),
        TemperatureSensor("temp-kitchen", "kitchen", "temperature", "°C", base=22.5, amplitude=2.5),
        PM25Sensor("pm25-kitchen", "kitchen", "pm25", "µg/m³", household=h),
        TDSSensor("tds-kitchen", "kitchen", "tds", "ppm"),
        MotionSensor("motion-hallway", "hallway", "motion", "bool"),
        VentilationState("erv-main", "hallway", "ventilation", "bool", household=h),
        DoorSensor("door-front", "entrance", "door", "bool"),
        DoorSensor("door-back", "kitchen", "door", "bool", open_chance=0.015),
    ]
    for s in sensors:
        if isinstance(s, TemperatureSensor | HumiditySensor | VOCSensor | TDSSensor | LeakSensor):
            s.fault_chance = min(1.0, s.fault_chance * f)
        elif isinstance(s, DoorSensor):
            s.left_open_chance = min(1.0, s.left_open_chance * f)
    return sensors


@dataclass
class Home:
    sensors: list[Sensor] | None = None
    household: Household = field(default_factory=Household)

    def __post_init__(self) -> None:
        if self.sensors is None:
            self.sensors = default_sensors(household=self.household)

    def tick(self, t: float, rng: random.Random) -> list[tuple[str, dict]]:
        self.household.step(t, rng)
        return [(s.topic, s.payload(t, rng)) for s in self.sensors]
