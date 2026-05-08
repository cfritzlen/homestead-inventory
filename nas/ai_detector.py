"""AI-powered wildlife detector using Claude Sonnet vision.

Polls Frigate camera snapshots on a timer and sends them to Claude
to identify animals (especially foxes) that Frigate's default model misses.
Saves detections as events for review in the security dashboard.
"""

import anthropic
import base64
import json
import os
import time
import threading
import requests
import paho.mqtt.client as mqtt
from datetime import datetime
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'))

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
FRIGATE_URL = "http://localhost:5000"
CAMERAS = ["coop_a", "coop_b"]
POLL_INTERVAL = 60  # seconds between checks
EVENTS_DIR = "/home/moco/homestead/ai-events"
SNAPSHOTS_DIR = os.path.join(EVENTS_DIR, "snapshots")
CLIPS_DIR = os.path.join(EVENTS_DIR, "clips")
EVENTS_FILE = os.path.join(EVENTS_DIR, "events.json")
MAX_EVENTS = 200  # keep last N events

# Clip settings: 5 seconds before detection, 15 seconds after
CLIP_BEFORE = 5
CLIP_AFTER = 15

# Active hours — 5:00 AM to 8:30 PM
ACTIVE_START = (5, 0)   # 5:00 AM
ACTIVE_END = (20, 30)   # 8:30 PM

# ntfy push notifications
NTFY_TOPIC = "homestead-coop-alerts-xk9m"
NTFY_URL = f"https://ntfy.sh/{NTFY_TOPIC}"
DASHBOARD_URL = "http://192.168.1.200:8080/security.html"

# MQTT for alarm triggers
MQTT_HOST = "localhost"
MQTT_PORT = 1883
ALARM_TOPIC = "homestead/alarm/trigger"
ALARM_ENABLED_TOPIC = "homestead/alarm/enabled/state"

# Animals that trigger the alarm
ALARM_LABELS = ["fox", "coyote", "raccoon"]

PROMPT = """Look at this security camera image from a chicken coop.
Tell me if you see any animals. Focus especially on foxes, but also note any other wildlife (raccoons, coyotes, hawks, owls, cats, dogs, etc).

IMPORTANT: These cameras have IR (infrared) illuminators that appear as bright glowing circles or spots in night vision mode. Do NOT identify IR lights as animals. They are part of the camera hardware. Also ignore lens flare, spiderwebs, and insects close to the lens.

Respond in this exact JSON format only, no other text:
{"animals_detected": true/false, "animals": [{"type": "fox", "confidence": "high/medium/low", "location": "where in the frame", "description": "brief description of what you see"}], "summary": "one line summary"}

If you see no animals at all, respond:
{"animals_detected": false, "animals": [], "summary": "No animals detected"}"""

ai_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

# MQTT client for alarm triggers
mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2)
alarm_enabled = True

def on_mqtt_connect(client, userdata, flags, reason_code, properties):
    print(f"MQTT connected (code: {reason_code})")
    client.subscribe(ALARM_ENABLED_TOPIC)

def on_mqtt_message(client, userdata, msg):
    global alarm_enabled
    if msg.topic == ALARM_ENABLED_TOPIC:
        state = msg.payload.decode().strip().lower()
        alarm_enabled = state in ("on", "true", "1")
        print(f"  Alarm {'enabled' if alarm_enabled else 'disabled'} (from MQTT)")

mqtt_client.on_connect = on_mqtt_connect
mqtt_client.on_message = on_mqtt_message

def connect_mqtt():
    try:
        mqtt_client.connect(MQTT_HOST, MQTT_PORT, 60)
        mqtt_client.loop_start()
    except Exception as e:
        print(f"  MQTT connect error: {e}")

def trigger_alarm_for(animal_type, camera):
    """Send alarm trigger via MQTT if enabled and animal is a threat."""
    if not alarm_enabled:
        print(f"  [{camera}] Alarm skipped — disabled")
        return
    if animal_type.lower() not in ALARM_LABELS:
        return
    try:
        mqtt_client.publish(ALARM_TOPIC, "alarm")
        print(f"  [{camera}] ALARM TRIGGERED for {animal_type}!")
    except Exception as e:
        print(f"  [{camera}] Alarm trigger failed: {e}")


def is_active_hour():
    now = datetime.now()
    current = (now.hour, now.minute)
    return ACTIVE_START <= current < ACTIVE_END


def get_snapshot(camera):
    url = f"{FRIGATE_URL}/api/{camera}/latest.jpg"
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200 and resp.content[:2] == b'\xff\xd8':
            return resp.content
    except Exception as e:
        print(f"  Error getting snapshot from {camera}: {e}")
    return None


def analyze_image(image_data):
    b64 = base64.standard_b64encode(image_data).decode("utf-8")
    try:
        response = ai_client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                    {"type": "text", "text": PROMPT}
                ]
            }]
        )
        text = response.content[0].text.strip()
        # Parse JSON from response
        if text.startswith("{"):
            return json.loads(text)
        # Try to extract JSON if wrapped in markdown
        if "```" in text:
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
            return json.loads(text.strip())
        return json.loads(text)
    except json.JSONDecodeError as e:
        print(f"  Failed to parse response: {text[:200]}")
        return None
    except Exception as e:
        print(f"  API error: {e}")
        return None


def save_event(camera, analysis, image_data):
    now = datetime.now()
    event_id = f"ai-{now.strftime('%Y%m%d-%H%M%S')}-{camera}"

    # Save snapshot
    snap_path = os.path.join(SNAPSHOTS_DIR, f"{event_id}.jpg")
    with open(snap_path, "wb") as f:
        f.write(image_data)

    event = {
        "id": event_id,
        "camera": camera,
        "time": now.isoformat(),
        "timestamp": now.timestamp(),
        "animals": analysis["animals"],
        "summary": analysis["summary"],
        "snapshot": f"snapshots/{event_id}.jpg",
        "source": "ai"
    }

    # Load existing events
    events = []
    if os.path.exists(EVENTS_FILE):
        try:
            with open(EVENTS_FILE) as f:
                events = json.load(f)
        except (json.JSONDecodeError, IOError):
            events = []

    events.insert(0, event)
    events = events[:MAX_EVENTS]

    with open(EVENTS_FILE, "w") as f:
        json.dump(events, f, indent=2)

    # Clean up old snapshots beyond MAX_EVENTS
    keep_ids = {e["id"] for e in events}
    for snap in Path(SNAPSHOTS_DIR).glob("ai-*.jpg"):
        if snap.stem not in keep_ids:
            snap.unlink()

    return event


def grab_clip(event_id, camera, detect_time):
    """Wait for recording to finish, then extract a 20s clip from Frigate."""
    # Wait for the 'after' portion to be recorded
    wait_secs = CLIP_AFTER + 5  # extra buffer
    print(f"  [{camera}] Clip will be grabbed in {wait_secs}s...")
    time.sleep(wait_secs)

    start_ts = detect_time - CLIP_BEFORE
    end_ts = detect_time + CLIP_AFTER

    # Frigate recording export API
    url = f"{FRIGATE_URL}/api/export/{camera}/start/{start_ts:.0f}/end/{end_ts:.0f}"
    clip_path = os.path.join(CLIPS_DIR, f"{event_id}.mp4")

    try:
        resp = requests.post(url, timeout=30)
        if resp.status_code == 200:
            # Frigate exports async — poll for the file or use the response
            export_data = resp.json() if resp.headers.get('content-type', '').startswith('application/json') else None
            print(f"  [{camera}] Export requested via Frigate API")
        else:
            print(f"  [{camera}] Frigate export API returned {resp.status_code}, trying direct recording download")
    except Exception as e:
        print(f"  [{camera}] Frigate export failed: {e}, trying direct recording download")

    # Fallback: try the recordings endpoint directly
    try:
        rec_url = f"{FRIGATE_URL}/api/{camera}/recordings"
        params = {"after": int(start_ts), "before": int(end_ts)}
        resp = requests.get(rec_url, params=params, timeout=10)
        if resp.status_code == 200:
            recordings = resp.json()
            if recordings:
                # Download and concatenate segments
                segments = []
                for rec in recordings:
                    seg_url = f"{FRIGATE_URL}/api/{camera}/start/{rec['start_time']:.6f}/end/{rec['end_time']:.6f}/clip.mp4"
                    seg_resp = requests.get(seg_url, timeout=30)
                    if seg_resp.status_code == 200:
                        segments.append(seg_resp.content)

                if segments:
                    # For simplicity, use the first segment that covers our window
                    with open(clip_path, 'wb') as f:
                        for seg in segments:
                            f.write(seg)
                    print(f"  [{camera}] Clip saved: {clip_path} ({os.path.getsize(clip_path) / 1024:.0f}KB)")

                    # Update event with clip path
                    update_event_clip(event_id, f"clips/{event_id}.mp4")
                    return
    except Exception as e:
        print(f"  [{camera}] Recording download failed: {e}")

    # Last resort: try the simple clip endpoint
    try:
        clip_url = f"{FRIGATE_URL}/api/{camera}/start/{start_ts:.6f}/end/{end_ts:.6f}/clip.mp4"
        resp = requests.get(clip_url, timeout=30)
        if resp.status_code == 200 and len(resp.content) > 1000:
            with open(clip_path, 'wb') as f:
                f.write(resp.content)
            print(f"  [{camera}] Clip saved: {clip_path} ({len(resp.content) / 1024:.0f}KB)")
            update_event_clip(event_id, f"clips/{event_id}.mp4")
        else:
            print(f"  [{camera}] No clip data available (status {resp.status_code})")
    except Exception as e:
        print(f"  [{camera}] Clip download failed: {e}")


def update_event_clip(event_id, clip_path):
    """Add clip path to an existing event in the events JSON."""
    try:
        with open(EVENTS_FILE) as f:
            events = json.load(f)
        for ev in events:
            if ev["id"] == event_id:
                ev["clip"] = clip_path
                break
        with open(EVENTS_FILE, "w") as f:
            json.dump(events, f, indent=2)
    except Exception as e:
        print(f"  Error updating event clip: {e}")


def send_notification(event, image_data):
    """Only send push notifications for foxes."""
    animals = [a["type"].lower() for a in event.get("animals", [])]
    if "fox" not in animals:
        return

    title = f"FOX detected on {event['camera']}"
    message = event.get("summary", "Fox spotted")
    try:
        resp = requests.post(
            NTFY_URL,
            data=image_data,
            headers={
                "Title": title,
                "Message": message,
                "Priority": "high",
                "Tags": "fox",
                "Click": DASHBOARD_URL,
                "Filename": f"{event['id']}.jpg",
            },
            timeout=15
        )
        if resp.status_code == 200:
            print(f"  [{event['camera']}] Fox notification sent")
        else:
            print(f"  [{event['camera']}] Notification failed: {resp.status_code}")
    except Exception as e:
        print(f"  [{event['camera']}] Notification error: {e}")


def poll_cameras():
    for camera in CAMERAS:
        image_data = get_snapshot(camera)
        if not image_data:
            continue

        size_kb = len(image_data) / 1024
        print(f"  [{camera}] Got snapshot ({size_kb:.0f}KB), analyzing...")

        analysis = analyze_image(image_data)
        if not analysis:
            continue

        if analysis.get("animals_detected"):
            animals = ", ".join(a["type"] for a in analysis.get("animals", []))
            print(f"  [{camera}] DETECTED: {animals} — {analysis['summary']}")
            event = save_event(camera, analysis, image_data)
            print(f"  [{camera}] Saved event: {event['id']}")
            send_notification(event, image_data)
            # Trigger alarm for threat animals (fox, coyote, raccoon)
            for a in analysis.get("animals", []):
                trigger_alarm_for(a["type"], camera)
            # Grab clip in background (waits for recording to finish)
            detect_time = event["timestamp"]
            threading.Thread(
                target=grab_clip,
                args=(event["id"], camera, detect_time),
                daemon=True
            ).start()
        else:
            print(f"  [{camera}] Clear")


def main():
    os.makedirs(CLIPS_DIR, exist_ok=True)
    connect_mqtt()
    print("=== AI Wildlife Detector ===")
    print(f"Cameras: {CAMERAS}")
    print(f"Poll interval: {POLL_INTERVAL}s")
    print(f"Active hours: {ACTIVE_START[0]}:{ACTIVE_START[1]:02d} - {ACTIVE_END[0]}:{ACTIVE_END[1]:02d}")
    print(f"Model: claude-sonnet-4-6")
    print(f"Clips: {CLIP_BEFORE}s before, {CLIP_AFTER}s after")
    print(f"Events dir: {EVENTS_DIR}")
    print()

    while True:
        if is_active_hour():
            now = datetime.now().strftime("%H:%M:%S")
            print(f"[{now}] Polling cameras...")
            poll_cameras()
        else:
            if datetime.now().minute == 0:
                print(f"  Outside active hours ({ACTIVE_START[0]}:{ACTIVE_START[1]:02d} - {ACTIVE_END[0]}:{ACTIVE_END[1]:02d})")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
