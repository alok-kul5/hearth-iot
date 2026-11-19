"""Threshold alert engine.

The engine is pure, in-memory logic: it takes readings (and the current time
for offline checks) and returns alert events. Storage and broadcasting are
handled by the caller, which keeps this easy to test.
"""

from __future__ import annotations

import operator
from dataclasses import dataclass
from pathlib import Path

import yaml

from .models import AlertEvent, Reading

OPS = {
    ">": operator.gt,
    ">=": operator.ge,
    "<": operator.lt,
    "<=": operator.le,
    "==": operator.eq,
}


@dataclass(frozen=True)
class Rule:
    name: str
    sensor_type: str
    op: str
    threshold: float
    severity: str = "warning"
    for_seconds: float = 0
    message: str = "{value} breached {threshold}"

    def __post_init__(self) -> None:
        if self.op not in OPS:
            raise ValueError(f"rule {self.name}: unknown operator {self.op!r}")

    def breached(self, value: float) -> bool:
        return OPS[self.op](value, self.threshold)


OFFLINE_RULE = "sensor_offline"


class AlertEngine:
    def __init__(self, rules: list[Rule], stale_after_seconds: float = 30) -> None:
        self.rules = rules
        self.stale_after = stale_after_seconds
        self._breach_since: dict[str, float] = {}  # alert key -> first breaching ts
        self._open: set[str] = set()  # alert keys currently open
        self._last_seen: dict[str, float] = {}

    @classmethod
    def from_yaml(cls, path: str | Path) -> AlertEngine:
        cfg = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        rules = [Rule(**r) for r in cfg.get("rules", [])]
        return cls(rules, cfg.get("stale_after_seconds", 30))

    @staticmethod
    def key(sensor_id: str, rule: str) -> str:
        return f"{sensor_id}:{rule}"

    def restore(self, open_keys: list[str]) -> None:
        """Re-load alerts that were still open when the service last stopped."""
        self._open.update(open_keys)

    def evaluate(self, r: Reading) -> list[AlertEvent]:
        events: list[AlertEvent] = []
        self._last_seen[r.sensor_id] = r.ts

        # A reading proves the sensor is alive again.
        offline_key = self.key(r.sensor_id, OFFLINE_RULE)
        if offline_key in self._open:
            self._open.discard(offline_key)
            events.append(
                AlertEvent(
                    kind="resolved", key=offline_key, rule=OFFLINE_RULE, sensor_id=r.sensor_id,
                    severity="warning", message="Sensor is reporting again", value=None, ts=r.ts,
                )
            )

        for rule in self.rules:
            if rule.sensor_type != r.type:
                continue
            k = self.key(r.sensor_id, rule.name)
            if rule.breached(r.value):
                since = self._breach_since.setdefault(k, r.ts)
                if k not in self._open and r.ts - since >= rule.for_seconds:
                    self._open.add(k)
                    events.append(
                        AlertEvent(
                            kind="opened", key=k, rule=rule.name, sensor_id=r.sensor_id,
                            severity=rule.severity,
                            message=rule.message.format(value=r.value, threshold=rule.threshold),
                            value=r.value, ts=r.ts,
                        )
                    )
            else:
                self._breach_since.pop(k, None)
                if k in self._open:
                    self._open.discard(k)
                    events.append(
                        AlertEvent(
                            kind="resolved", key=k, rule=rule.name, sensor_id=r.sensor_id,
                            severity=rule.severity, message="Back in normal range",
                            value=r.value, ts=r.ts,
                        )
                    )
        return events

    def check_offline(self, now: float) -> list[AlertEvent]:
        events = []
        for sensor_id, last in self._last_seen.items():
            k = self.key(sensor_id, OFFLINE_RULE)
            if now - last > self.stale_after and k not in self._open:
                self._open.add(k)
                events.append(
                    AlertEvent(
                        kind="opened", key=k, rule=OFFLINE_RULE, sensor_id=sensor_id,
                        severity="warning",
                        message=f"No reading for over {int(self.stale_after)}s",
                        value=None, ts=now,
                    )
                )
        return events

    def is_online(self, sensor_id: str, now: float) -> bool:
        last = self._last_seen.get(sensor_id)
        return last is not None and now - last <= self.stale_after
