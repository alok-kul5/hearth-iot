"""Turns raw MQTT messages into stored readings, alerts and live updates."""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable

from pydantic import ValidationError

from .models import AlertEvent, Reading
from .rules import AlertEngine
from .storage import Storage

log = logging.getLogger(__name__)

Broadcast = Callable[[dict], None]


class Ingestor:
    def __init__(self, storage: Storage, engine: AlertEngine, broadcast: Broadcast | None = None) -> None:
        self.storage = storage
        self.engine = engine
        self.broadcast = broadcast or (lambda msg: None)
        self.received = 0
        self.rejected = 0
        self._lock = threading.Lock()  # engine state is touched by the MQTT thread and the offline checker

    def handle(self, topic: str, payload: bytes) -> Reading | None:
        try:
            reading = Reading.model_validate(json.loads(payload))
        except (json.JSONDecodeError, UnicodeDecodeError, ValidationError) as exc:
            self.rejected += 1
            log.warning("rejected message on %s: %s", topic, str(exc).splitlines()[0])
            return None
        if not topic.endswith("/" + reading.sensor_id):
            self.rejected += 1
            log.warning("topic %s does not match sensor_id %s", topic, reading.sensor_id)
            return None

        self.received += 1
        self.storage.add_reading(reading)
        self.broadcast({"kind": "reading", "data": reading.model_dump()})
        with self._lock:
            events = self.engine.evaluate(reading)
        self._publish_alerts(events)
        return reading

    def check_offline(self, now: float) -> None:
        with self._lock:
            events = self.engine.check_offline(now)
        self._publish_alerts(events)

    def _publish_alerts(self, events: list[AlertEvent]) -> None:
        for e in events:
            row = self.storage.apply_alert(e)
            if row is not None:
                log.info("alert %s: %s %s", e.kind, e.key, e.message)
                self.broadcast({"kind": "alert", "event": e.kind, "data": row})
