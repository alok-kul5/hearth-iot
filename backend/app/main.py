"""FastAPI app: REST API, WebSocket live feed and the dashboard page."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState

from .config import APP_DIR, Settings
from .config import settings as default_settings
from .ingest import Ingestor
from .mqtt_client import MqttSubscriber
from .rules import AlertEngine
from .storage import Storage

log = logging.getLogger("dashboard")
STATIC_DIR = APP_DIR / "static"


class Hub:
    """Fans live messages out to every connected browser."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def _send_all(self, text: str) -> None:
        for ws in list(self.clients):
            if ws.application_state != WebSocketState.CONNECTED:
                continue  # registered but the handshake hasn't finished yet
            try:
                await ws.send_text(text)
            except Exception:
                self.clients.discard(ws)

    def publish(self, msg: dict) -> None:
        """Safe to call from any thread (the MQTT thread calls this)."""
        if self.loop is None or not self.clients:
            return
        asyncio.run_coroutine_threadsafe(self._send_all(json.dumps(msg)), self.loop)


def create_app(cfg: Settings = default_settings) -> FastAPI:
    storage = Storage(cfg.db_path)
    engine = AlertEngine.from_yaml(cfg.rules_path)
    engine.restore(storage.open_alert_keys())
    hub = Hub()
    ingestor = Ingestor(storage, engine, hub.publish)
    subscriber = MqttSubscriber(cfg.mqtt_host, cfg.mqtt_port, cfg.mqtt_topic, ingestor.handle)

    async def housekeeping() -> None:
        last_prune = 0.0
        while True:
            now = time.time()
            ingestor.check_offline(now)
            if now - last_prune > 600:
                removed = storage.prune(now - cfg.retention_hours * 3600)
                if removed:
                    log.info("pruned %d old readings", removed)
                last_prune = now
            await asyncio.sleep(5)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        hub.loop = asyncio.get_running_loop()
        if cfg.enable_mqtt:
            subscriber.start()
        task = asyncio.create_task(housekeeping())
        yield
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
        if cfg.enable_mqtt:
            subscriber.stop()
        storage.close()

    app = FastAPI(title="Smart Home Sensor Dashboard", version="1.0.0", lifespan=lifespan)
    app.state.ingestor = ingestor
    app.state.storage = storage

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "mqtt_connected": subscriber.connected,
            "messages_received": ingestor.received,
            "messages_rejected": ingestor.rejected,
            "readings_stored": storage.reading_count(),
        }

    @app.get("/api/sensors")
    def sensors():
        now = time.time()
        return [{**s, "online": engine.is_online(s["sensor_id"], now)} for s in storage.sensors()]

    @app.get("/api/sensors/{sensor_id}/history")
    def history(sensor_id: str, minutes: float = Query(15, gt=0, le=24 * 60)):
        if not any(s["sensor_id"] == sensor_id for s in storage.sensors()):
            raise HTTPException(404, f"unknown sensor {sensor_id}")
        return storage.history(sensor_id, time.time() - minutes * 60)

    @app.get("/api/alerts")
    def alerts(active: bool = False, limit: int = Query(50, ge=1, le=500)):
        return storage.alerts(active_only=active, limit=limit)

    @app.get("/api/rules")
    def rules():
        return {
            "stale_after_seconds": engine.stale_after,
            "rules": [r.__dict__ for r in engine.rules],
        }

    @app.websocket("/ws")
    async def live(ws: WebSocket):
        hub.clients.add(ws)
        await ws.accept()
        try:
            while True:
                await ws.receive_text()  # we only push; this just notices disconnects
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(ws)

    @app.get("/", include_in_schema=False)
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def build() -> FastAPI:
    """Entry point for `uvicorn app.main:build --factory`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    return create_app()
