"""Circadian lighting: colour temperature and brightness that follow the time of day.

Cool, bright light in the morning and middle of the day; warm, dim light in the
evening so it is easier to wind down; a faint amber night light after 23:00.
The schedule is a list of keyframes with straight-line fades between them.
The backend sends the current setpoint to the simulated light over MQTT
(`hearth/cmd/light-living`), and the light reports back what it is showing.
"""

from __future__ import annotations

import json
from datetime import datetime, tzinfo

# (local hour, colour temperature in kelvin, brightness in %)
KEYFRAMES: list[tuple[float, int, int]] = [
    (0.0, 1800, 3),
    (5.5, 1800, 3),
    (6.5, 2400, 30),   # sunrise fade
    (8.0, 4000, 80),
    (12.0, 5500, 100),  # coolest and brightest around midday
    (15.0, 5000, 100),
    (18.0, 3500, 85),
    (20.0, 2700, 60),   # warm and dimmer in the evening
    (22.0, 2200, 25),
    (23.0, 1800, 5),    # night light
    (24.0, 1800, 3),
]


def setpoint(hour: float) -> tuple[int, int]:
    """Colour temperature (K, rounded to 50) and brightness (%) for a local hour of day."""
    hour %= 24
    for (h0, k0, b0), (h1, k1, b1) in zip(KEYFRAMES, KEYFRAMES[1:], strict=False):
        if h0 <= hour <= h1:
            f = (hour - h0) / (h1 - h0)
            kelvin = k0 + (k1 - k0) * f
            return int(round(kelvin / 50) * 50), int(round(b0 + (b1 - b0) * f))
    raise AssertionError("keyframes must cover 0-24 h")  # pragma: no cover


def schedule(step_minutes: int = 30) -> list[dict]:
    """The whole day sampled every `step_minutes`, for the dashboard's chart."""
    out = []
    for m in range(0, 24 * 60 + 1, step_minutes):
        kelvin, brightness = setpoint(m / 60)
        out.append({"hour": m / 60, "kelvin": kelvin, "brightness": brightness})
    return out


def local_hour(ts: float, tz: tzinfo) -> float:
    d = datetime.fromtimestamp(ts, tz)
    return d.hour + d.minute / 60 + d.second / 3600


class CircadianLight:
    """Works out when to send the light a new setpoint."""

    device = "light-living"

    def __init__(self, tz: tzinfo) -> None:
        self.tz = tz
        self.last: tuple[int, int] | None = None

    def target(self, now: float) -> tuple[int, int]:
        return setpoint(local_hour(now, self.tz))

    def tick(self, now: float, force: bool = False) -> str | None:
        """The command payload if the setpoint changed since the last one sent, else None."""
        target = self.target(now)
        if target == self.last and not force:
            return None
        self.last = target
        kelvin, brightness = target
        return json.dumps({"color_temp_k": kelvin, "brightness": brightness})
