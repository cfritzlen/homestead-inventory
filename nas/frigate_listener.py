import asyncio
import json
import time
import paho.mqtt.client as mqtt
from kasa_control import trigger_alarm

MQTT_HOST = "localhost"
MQTT_PORT = 1883

# Frigate COCO model can't detect foxes — alarm only fires from AI detector via MQTT
# This listener no longer triggers alarms on its own detections
TRIGGER_LABELS = []

# Cooldown - don't re-trigger within this many seconds
COOLDOWN_SECONDS = 60

# How long alarm stays on (seconds)
ALARM_DURATION = 10

last_trigger = 0
alarm_enabled = True

def on_connect(client, userdata, flags, reason_code, properties):
    print(f"Connected to MQTT (code: {reason_code})")
    client.subscribe("frigate/events")
    client.subscribe("homestead/alarm/enabled")
    print("Listening for Frigate detection events...")
    print(f"Triggers: {TRIGGER_LABELS}")
    print(f"Cooldown: {COOLDOWN_SECONDS}s, Duration: {ALARM_DURATION}s")
    # Publish current state so the UI picks it up on connect
    client.publish("homestead/alarm/enabled/state", "on", retain=True)

def on_message(client, userdata, msg):
    global last_trigger, alarm_enabled

    # Handle enable/disable commands
    if msg.topic == "homestead/alarm/enabled":
        payload = msg.payload.decode().strip().lower()
        alarm_enabled = payload in ("on", "true", "1", "enable")
        state = "on" if alarm_enabled else "off"
        print(f"  Auto-alarm {'ENABLED' if alarm_enabled else 'DISABLED'}")
        client.publish("homestead/alarm/enabled/state", state, retain=True)
        return

    try:
        data = json.loads(msg.payload)
    except json.JSONDecodeError:
        return

    event_type = data.get("type")
    after = data.get("after", {})
    label = after.get("label", "")
    camera = after.get("camera", "")
    score = after.get("top_score", 0)

    # Only trigger on "new" events (object first appears)
    if event_type != "new":
        return

    if label not in TRIGGER_LABELS:
        return

    if not alarm_enabled:
        print(f"  [{label}] on {camera} (score {score:.0%}) - skipped (alarm disabled)")
        return

    now = time.time()
    if now - last_trigger < COOLDOWN_SECONDS:
        print(f"  [{label}] on {camera} (score {score:.0%}) - skipped (cooldown)")
        return

    last_trigger = now
    print(f"  ALARM! [{label}] on {camera} (score {score:.0%})")
    asyncio.run(trigger_alarm(ALARM_DURATION))

if __name__ == "__main__":
    print("=== Frigate Alarm Trigger ===")
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    client.loop_forever()
