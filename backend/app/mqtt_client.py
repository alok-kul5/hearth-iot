"""MQTT connection: subscribes and hands each message to a callback, and publishes commands.

paho runs its network loop on its own thread and reconnects on its own if the
broker restarts. A retained last-will marks Hearth offline on `hearth/status`
if the backend drops off, which Home Assistant uses for entity availability.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

import paho.mqtt.client as mqtt

log = logging.getLogger(__name__)


STATUS_TOPIC = "hearth/status"


class MqttSubscriber:
    def __init__(
        self,
        host: str,
        port: int,
        topics: str | list[str],
        on_message: Callable[[str, bytes], None],
        on_connect: Callable[[], None] | None = None,
    ) -> None:
        self.host, self.port = host, port
        self.topics = [topics] if isinstance(topics, str) else list(topics)
        self.connected = False
        self._on_message = on_message
        self._on_connect = on_connect
        self._client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="home-dashboard-backend")
        self._client.will_set(STATUS_TOPIC, "offline", qos=1, retain=True)
        self._client.on_connect = self._handle_connect
        self._client.on_disconnect = self._handle_disconnect
        self._client.on_message = self._handle_message
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)

    def start(self) -> None:
        # connect_async + loop_start keeps retrying in the background, so the
        # API comes up even if the broker is not ready yet.
        self._client.connect_async(self.host, self.port, keepalive=30)
        self._client.loop_start()

    def stop(self) -> None:
        if self.connected:
            self._client.publish(STATUS_TOPIC, "offline", qos=1, retain=True).wait_for_publish(2)
        self._client.loop_stop()
        self._client.disconnect()

    def publish(self, topic: str, payload: str, retain: bool = False) -> None:
        # QoS 1 messages published while disconnected are queued by paho and sent on reconnect.
        self._client.publish(topic, payload, qos=1, retain=retain)

    def _handle_connect(self, client, userdata, flags, reason_code, properties) -> None:
        if reason_code.is_failure:
            log.error("MQTT connect failed: %s", reason_code)
            return
        self.connected = True
        client.subscribe([(t, 1) for t in self.topics])
        client.publish(STATUS_TOPIC, "online", qos=1, retain=True)
        log.info("connected to %s:%d, subscribed to %s", self.host, self.port, ", ".join(self.topics))
        if self._on_connect:
            try:
                self._on_connect()
            except Exception:
                log.exception("error in on_connect hook")

    def _handle_disconnect(self, client, userdata, flags, reason_code, properties) -> None:
        self.connected = False
        log.warning("MQTT disconnected: %s", reason_code)

    def _handle_message(self, client, userdata, msg) -> None:
        try:
            self._on_message(msg.topic, msg.payload)
        except Exception:  # never let one bad message kill the network thread
            log.exception("error handling message on %s", msg.topic)
