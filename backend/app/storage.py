"""SQLite storage for readings, latest sensor state and alerts.

The MQTT thread writes and the API reads, so one connection is shared behind a
lock. WAL mode keeps reads from blocking on writes.
"""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path

from .models import AlertEvent, Reading

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id        INTEGER PRIMARY KEY,
    sensor_id TEXT NOT NULL,
    value     REAL NOT NULL,
    ts        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_readings_sensor_ts ON readings (sensor_id, ts);

CREATE TABLE IF NOT EXISTS sensors (
    sensor_id  TEXT PRIMARY KEY,
    room       TEXT NOT NULL,
    type       TEXT NOT NULL,
    unit       TEXT NOT NULL,
    last_value REAL,
    last_ts    REAL
);

CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL,
    rule        TEXT NOT NULL,
    sensor_id   TEXT NOT NULL,
    severity    TEXT NOT NULL,
    message     TEXT NOT NULL,
    value       REAL,
    opened_at   REAL NOT NULL,
    resolved_at REAL
);
CREATE INDEX IF NOT EXISTS ix_alerts_open ON alerts (key) WHERE resolved_at IS NULL;
"""


class Storage:
    def __init__(self, path: str) -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    # --- writes -----------------------------------------------------------
    def add_reading(self, r: Reading) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO readings (sensor_id, value, ts) VALUES (?, ?, ?)",
                (r.sensor_id, r.value, r.ts),
            )
            self._db.execute(
                """INSERT INTO sensors (sensor_id, room, type, unit, last_value, last_ts)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(sensor_id) DO UPDATE SET
                     room=excluded.room, type=excluded.type, unit=excluded.unit,
                     last_value=excluded.last_value, last_ts=excluded.last_ts
                   WHERE excluded.last_ts >= sensors.last_ts""",
                (r.sensor_id, r.room, r.type, r.unit, r.value, r.ts),
            )

    def apply_alert(self, e: AlertEvent) -> dict | None:
        """Persist an alert event and return the alert row it touched."""
        with self._lock, self._db:
            if e.kind == "opened":
                cur = self._db.execute(
                    """INSERT INTO alerts (key, rule, sensor_id, severity, message, value, opened_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (e.key, e.rule, e.sensor_id, e.severity, e.message, e.value, e.ts),
                )
                alert_id = cur.lastrowid
            else:
                row = self._db.execute(
                    "SELECT id FROM alerts WHERE key = ? AND resolved_at IS NULL ORDER BY id DESC LIMIT 1",
                    (e.key,),
                ).fetchone()
                if row is None:
                    return None
                alert_id = row["id"]
                self._db.execute("UPDATE alerts SET resolved_at = ? WHERE id = ?", (e.ts, alert_id))
            row = self._db.execute("SELECT * FROM alerts WHERE id = ?", (alert_id,)).fetchone()
            return dict(row)

    def prune(self, older_than_ts: float) -> int:
        with self._lock, self._db:
            return self._db.execute("DELETE FROM readings WHERE ts < ?", (older_than_ts,)).rowcount

    # --- reads ------------------------------------------------------------
    def sensors(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM sensors ORDER BY room, sensor_id").fetchall()
        return [dict(r) for r in rows]

    def history(self, sensor_id: str, since_ts: float, max_points: int = 300) -> list[dict]:
        """Readings since `since_ts`, averaged into at most ~max_points buckets."""
        with self._lock:
            span = self._db.execute(
                "SELECT MIN(ts) AS lo, MAX(ts) AS hi, COUNT(*) AS n FROM readings WHERE sensor_id = ? AND ts >= ?",
                (sensor_id, since_ts),
            ).fetchone()
            if not span["n"]:
                return []
            if span["n"] <= max_points:
                rows = self._db.execute(
                    "SELECT ts, value FROM readings WHERE sensor_id = ? AND ts >= ? ORDER BY ts",
                    (sensor_id, since_ts),
                ).fetchall()
            else:
                bucket = max((span["hi"] - span["lo"]) / max_points, 1e-9)
                rows = self._db.execute(
                    """SELECT AVG(ts) AS ts, AVG(value) AS value
                       FROM readings WHERE sensor_id = ? AND ts >= ?
                       GROUP BY CAST((ts - ?) / ? AS INTEGER) ORDER BY ts""",
                    (sensor_id, since_ts, span["lo"], bucket),
                ).fetchall()
        return [{"ts": r["ts"], "value": round(r["value"], 3)} for r in rows]

    def alerts(self, active_only: bool = False, limit: int = 50) -> list[dict]:
        sql = "SELECT * FROM alerts"
        if active_only:
            sql += " WHERE resolved_at IS NULL"
        sql += " ORDER BY opened_at DESC LIMIT ?"
        with self._lock:
            rows = self._db.execute(sql, (limit,)).fetchall()
        return [dict(r) for r in rows]

    def open_alert_keys(self) -> list[str]:
        with self._lock:
            rows = self._db.execute("SELECT key FROM alerts WHERE resolved_at IS NULL").fetchall()
        return [r["key"] for r in rows]

    def reading_count(self) -> int:
        with self._lock:
            return self._db.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
