"""Automation actions: switch devices on while the alerts that ask for them are open.

A rule lists the devices it `activates`. A device stays on while at least one
of those alerts is open and goes off when the last one resolves, so CO2 in the
bedroom clearing doesn't stop the ERV while the kitchen is still full of smoke.
Commands go out as MQTT messages on `hearth/cmd/{device}` (retained, so a device
that restarts picks up its current state).
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from .models import AlertEvent
from .rules import Rule

log = logging.getLogger(__name__)

Send = Callable[[str, str], None]  # (device, "ON" | "OFF")


class Automations:
    def __init__(self, rules: list[Rule], send: Send | None = None) -> None:
        self._wants = {r.name: r.activates for r in rules if r.activates}
        self._demand: dict[str, set[str]] = {d: set() for devices in self._wants.values() for d in devices}
        self.send = send or (lambda device, state: None)

    @property
    def devices(self) -> list[str]:
        return sorted(self._demand)

    def restore(self, open_keys: list[str]) -> None:
        """Rebuild demand from alerts that were open when the service stopped (no commands sent)."""
        for key in open_keys:
            rule = key.rsplit(":", 1)[-1]
            for device in self._wants.get(rule, ()):
                self._demand[device].add(key)

    def sync(self) -> None:
        """Send every device its current state, e.g. after (re)connecting to the broker."""
        for device, keys in self._demand.items():
            self.send(device, "ON" if keys else "OFF")

    def apply(self, event: AlertEvent) -> list[tuple[str, str]]:
        sent = []
        for device in self._wants.get(event.rule, ()):
            keys = self._demand[device]
            was_on = bool(keys)
            if event.kind == "opened":
                keys.add(event.key)
            else:
                keys.discard(event.key)
            if bool(keys) != was_on:
                state = "ON" if keys else "OFF"
                log.info("automation: %s %s (%s %s)", device, state, event.rule, event.kind)
                self.send(device, state)
                sent.append((device, state))
        return sent

    def state(self) -> dict[str, dict]:
        return {d: {"state": "ON" if keys else "OFF", "because": sorted(keys)} for d, keys in self._demand.items()}
