"""Simulated home sensors.

Each sensor produces plausible readings: temperatures follow a daily curve plus a
random walk, humidity drifts slowly, motion fires as random events, and doors
open and close. A small chance of a fault (heat spike, humidity surge, a door
left open) is built in so the dashboard's threshold alerts have something to catch.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field


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


def default_sensors(fault_scale: float = 1.0) -> list[Sensor]:
    """The eight sensors of the simulated home.

    `fault_scale` multiplies how often faults happen (used by --demo).
    """
    f = fault_scale
    sensors: list[Sensor] = [
        TemperatureSensor("temp-living", "living_room", "temperature", "°C", base=21.5),
        HumiditySensor("hum-living", "living_room", "humidity", "%", base=45),
        TemperatureSensor("temp-bedroom", "bedroom", "temperature", "°C", base=19.5, amplitude=1.5),
        HumiditySensor("hum-bathroom", "bathroom", "humidity", "%", base=55),
        TemperatureSensor("temp-kitchen", "kitchen", "temperature", "°C", base=22.5, amplitude=2.5),
        MotionSensor("motion-hallway", "hallway", "motion", "bool"),
        DoorSensor("door-front", "entrance", "door", "bool"),
        DoorSensor("door-back", "kitchen", "door", "bool", open_chance=0.015),
    ]
    for s in sensors:
        if isinstance(s, TemperatureSensor | HumiditySensor):
            s.fault_chance = min(1.0, s.fault_chance * f)
        elif isinstance(s, DoorSensor):
            s.left_open_chance = min(1.0, s.left_open_chance * f)
    return sensors


@dataclass
class Home:
    sensors: list[Sensor] = field(default_factory=default_sensors)

    def tick(self, t: float, rng: random.Random) -> list[tuple[str, dict]]:
        return [(s.topic, s.payload(t, rng)) for s in self.sensors]
