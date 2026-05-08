"""Capture camera stills at a fast interval during a review window.

Saves snapshots from all cameras every N seconds during a configured
time window. No AI analysis — just raw captures for manual review.
"""

import json
import os
import time
import requests
from datetime import datetime
from pathlib import Path

FRIGATE_URL = "http://localhost:5000"
CAMERAS = ["coop_a", "coop_b"]
CAPTURE_INTERVAL = 15  # seconds
STILLS_DIR = "/home/moco/homestead/ai-events/stills"
INDEX_FILE = "/home/moco/homestead/ai-events/stills.json"
MAX_STILLS_PER_DAY = 3000  # ~720 per camera per hour at 15s

# Capture window (24h format, inclusive of minutes)
WINDOW_START_H, WINDOW_START_M = 5, 0
WINDOW_END_H, WINDOW_END_M = 6, 30


def in_capture_window():
    now = datetime.now()
    start = now.replace(hour=WINDOW_START_H, minute=WINDOW_START_M, second=0)
    end = now.replace(hour=WINDOW_END_H, minute=WINDOW_END_M, second=0)
    return start <= now < end


def get_snapshot(camera):
    url = f"{FRIGATE_URL}/api/{camera}/latest.jpg"
    try:
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200 and resp.content[:2] == b'\xff\xd8':
            return resp.content
    except Exception as e:
        print(f"  Error getting snapshot from {camera}: {e}")
    return None


def ensure_today_dir():
    today = datetime.now().strftime("%Y-%m-%d")
    day_dir = os.path.join(STILLS_DIR, today)
    os.makedirs(day_dir, exist_ok=True)
    return day_dir, today


def capture_stills():
    day_dir, today = ensure_today_dir()
    now = datetime.now()
    ts = now.strftime("%H%M%S")

    stills = []
    for camera in CAMERAS:
        image_data = get_snapshot(camera)
        if not image_data:
            continue

        filename = f"{ts}-{camera}.jpg"
        filepath = os.path.join(day_dir, filename)
        with open(filepath, "wb") as f:
            f.write(image_data)

        stills.append({
            "file": f"stills/{today}/{filename}",
            "camera": camera,
            "time": now.isoformat(),
            "timestamp": now.timestamp()
        })

    return stills


def update_index(new_stills):
    # Load existing index
    index = {"date": datetime.now().strftime("%Y-%m-%d"), "stills": []}
    if os.path.exists(INDEX_FILE):
        try:
            with open(INDEX_FILE) as f:
                index = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass

    # Reset if new day
    today = datetime.now().strftime("%Y-%m-%d")
    if index.get("date") != today:
        index = {"date": today, "stills": []}

    index["stills"].extend(new_stills)
    index["stills"] = index["stills"][-MAX_STILLS_PER_DAY:]

    with open(INDEX_FILE, "w") as f:
        json.dump(index, f)


def cleanup_old_days(keep_days=3):
    """Remove stills older than keep_days."""
    if not os.path.exists(STILLS_DIR):
        return
    today = datetime.now()
    for day_dir in Path(STILLS_DIR).iterdir():
        if not day_dir.is_dir():
            continue
        try:
            dir_date = datetime.strptime(day_dir.name, "%Y-%m-%d")
            if (today - dir_date).days > keep_days:
                for f in day_dir.iterdir():
                    f.unlink()
                day_dir.rmdir()
                print(f"  Cleaned up old stills: {day_dir.name}")
        except ValueError:
            pass


def main():
    print("=== Still Capture ===")
    print(f"Cameras: {CAMERAS}")
    print(f"Interval: {CAPTURE_INTERVAL}s")
    print(f"Window: {WINDOW_START_H}:{WINDOW_START_M:02d} - {WINDOW_END_H}:{WINDOW_END_M:02d}")
    print(f"Stills dir: {STILLS_DIR}")
    print()

    os.makedirs(STILLS_DIR, exist_ok=True)
    cleanup_old_days()

    while True:
        if in_capture_window():
            now = datetime.now().strftime("%H:%M:%S")
            stills = capture_stills()
            if stills:
                update_index(stills)
                print(f"[{now}] Captured {len(stills)} stills")
        else:
            if datetime.now().second < CAPTURE_INTERVAL:
                hour = datetime.now().hour
                minute = datetime.now().minute
                print(f"  Outside capture window ({hour}:{minute:02d})")
                cleanup_old_days()

        time.sleep(CAPTURE_INTERVAL)


if __name__ == "__main__":
    main()
