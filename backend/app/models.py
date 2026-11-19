from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SensorType = Literal["temperature", "humidity", "motion", "door"]


class Reading(BaseModel):
    """One sensor reading as published on MQTT."""

    sensor_id: str = Field(min_length=1, max_length=64)
    room: str = Field(min_length=1, max_length=64)
    type: SensorType
    value: float
    unit: str = Field(max_length=16)
    ts: float = Field(gt=0, description="unix timestamp, seconds")


class AlertEvent(BaseModel):
    """An alert opening or resolving, as produced by the rule engine."""

    kind: Literal["opened", "resolved"]
    key: str
    rule: str
    sensor_id: str
    severity: Literal["info", "warning", "critical"]
    message: str
    value: float | None
    ts: float
