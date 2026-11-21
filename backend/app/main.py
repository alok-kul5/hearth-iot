"""FastAPI app: REST API, WebSocket live feed and the dashboard page."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState

from . import circadian
from .automations import Automations
from .config import APP_DIR, Settings
from .config import settings as default_settings
from .ha_discovery import COMMAND_PREFIX, Discovery, discovery_message
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
    open_keys = storage.open_alert_keys()
    engine.restore(open_keys)
    hub = Hub()
    tz = ZoneInfo(cfg.timezone)
    light = circadian.CircadianLight(tz)

    # Outgoing MQTT goes through `publish`; it is a no-op when MQTT is off (tests).
    def publish(topic: str, payload: str, retain: bool = False) -> None:
        if cfg.enable_mqtt:
            subscriber.publish(topic, payload, retain)

    def command(device: str, payload: str) -> None:
        publish(f"{COMMAND_PREFIX}/{device}", payload, True)

    automations = Automations(engine.rules, command)
    automations.restore(open_keys)
    discovery = Discovery(publish, cfg.ha_prefix)
    ingestor = Ingestor(storage, engine, hub.publish, automations, discovery.on_reading if cfg.ha_discovery else None)

    def on_message(topic: str, payload: bytes) -> None:
        if topic == discovery.status_topic:
            if payload.strip().lower() == b"online":  # Home Assistant restarted: announce everything again
                log.info("Home Assistant online, re-sent %d discovery configs", discovery.announce_all(storage.sensors()))
            return
        ingestor.handle(topic, payload)

    def on_connect() -> None:
        automations.sync()
        if cfg.ha_discovery:
            discovery.announce_all(storage.sensors())
        if cfg.circadian:
            command(light.device, light.tick(time.time(), force=True))

    topics = [cfg.mqtt_topic] + ([discovery.status_topic] if cfg.ha_discovery else [])
    subscriber = MqttSubscriber(cfg.mqtt_host, cfg.mqtt_port, topics, on_message, on_connect)

    async def housekeeping() -> None:
        last_prune = 0.0
        while True:
            now = time.time()
            ingestor.check_offline(now)
            if cfg.circadian and (cmd := light.tick(now)):
                command(light.device, cmd)
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
    app.state.on_message = on_message
    app.state.discovery = discovery

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

    @app.get("/api/automations")
    def automation_state():
        """Devices switched by rules, whether each is on, and which open alerts are keeping it on."""
        return automations.state()

    @app.get("/api/circadian")
    def circadian_schedule():
        now = time.time()
        kelvin, brightness = light.target(now)
        return {
            "timezone": cfg.timezone,
            "hour": round(circadian.local_hour(now, tz), 3),
            "target": {"kelvin": kelvin, "brightness": brightness},
            "schedule": circadian.schedule(30),
        }

    @app.get("/api/homeassistant/discovery")
    def ha_discovery():
        """The MQTT Discovery configs Hearth publishes for Home Assistant, one per known sensor."""
        msgs = [discovery_message(s, cfg.ha_prefix) for s in storage.sensors()]
        return [{"topic": t, "config": c} for t, c in filter(None, msgs)]

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
