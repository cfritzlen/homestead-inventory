"""HTTP API for event review state and verdict labeling.

Runs on port 8081. The security dashboard POSTs here to mark events
as reviewed, favorited, or labeled with a verdict (confirmed/false_positive).
Verdict data can be used for future model training.
"""

import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler

STATE_FILE = "/home/moco/homestead/ai-events/review-state.json"
SETTINGS_FILE = "/home/moco/homestead/ai-events/ai-settings.json"
PORT = 8081

DEFAULT_SETTINGS = {
    "model": "claude-sonnet-4-6",
    "max_tokens": 300,
    "poll_interval": 60,
    "active_start": "05:00",
    "active_end": "20:30",
    "cameras": ["coop_a", "coop_b"],
    "alarm_labels": ["fox", "coyote", "raccoon"],
    "prompt": "Look at this security camera image from a chicken coop.\nTell me if you see any animals. Focus especially on foxes, but also note any other wildlife (raccoons, coyotes, hawks, owls, cats, dogs, etc).\n\nIMPORTANT: These cameras have IR (infrared) illuminators that appear as bright glowing circles or spots in night vision mode. Do NOT identify IR lights as animals. They are part of the camera hardware. Also ignore lens flare, spiderwebs, and insects close to the lens.\n\nRespond in this exact JSON format only, no other text:\n{\"animals_detected\": true/false, \"animals\": [{\"type\": \"fox\", \"confidence\": \"high/medium/low\", \"location\": \"where in the frame\", \"description\": \"brief description of what you see\"}], \"summary\": \"one line summary\"}\n\nIf you see no animals at all, respond:\n{\"animals_detected\": false, \"animals\": [], \"summary\": \"No animals detected\"}"
}


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f)


def load_settings():
    settings = dict(DEFAULT_SETTINGS)
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE) as f:
                saved = json.load(f)
            settings.update(saved)
        except (json.JSONDecodeError, IOError):
            pass
    return settings


def save_settings(settings):
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f, indent=2)


class ReviewHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/review-state":
            state = load_state()
            body = json.dumps(state).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/ai-settings":
            settings = load_settings()
            body = json.dumps(settings).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/ai-settings":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                update = json.loads(body)
                settings = load_settings()
                # Only allow known keys
                for key in DEFAULT_SETTINGS:
                    if key in update:
                        settings[key] = update[key]
                save_settings(settings)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == "/review-state":
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            try:
                update = json.loads(body)
                event_id = update.get("id")
                if not event_id:
                    raise ValueError("Missing id")

                state = load_state()
                if event_id not in state:
                    state[event_id] = {}

                if "reviewed" in update:
                    state[event_id]["reviewed"] = update["reviewed"]
                if "favorite" in update:
                    state[event_id]["favorite"] = update["favorite"]
                if "verdict" in update:
                    # "confirmed" = real detection, "false_positive" = bad call
                    state[event_id]["verdict"] = update["verdict"]
                if "training_label" in update:
                    # e.g. "my_duck", "fox", "ir_light", "nothing"
                    state[event_id]["training_label"] = update["training_label"]

                save_state(state)

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())
            except Exception as e:
                self.send_response(400)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), ReviewHandler)
    print(f"Review API running on port {PORT}")
    server.serve_forever()
