"""Fetch a snapshot from Reolink camera and save as JPEG."""

import requests
import urllib3
import json
import os
from datetime import datetime

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REOLINK_HOST = os.environ.get("REOLINK_HOST", "192.168.1.65")
REOLINK_USER = os.environ.get("REOLINK_USER", "admin")
REOLINK_PASS = os.environ.get("REOLINK_PASS", "")

SNAPSHOT_FILE = os.path.join(SCRIPT_DIR, "camera-snapshot.jpg")
META_FILE = os.path.join(SCRIPT_DIR, "camera-data.json")


def try_direct_snap(scheme):
    """Try the direct GET snapshot endpoint."""
    url = (
        f"{scheme}://{REOLINK_HOST}/cgi-bin/api.cgi"
        f"?cmd=Snap&channel=0&rs=abc123"
        f"&user={REOLINK_USER}&password={REOLINK_PASS}"
    )
    resp = requests.get(url, timeout=10, verify=False)
    resp.raise_for_status()

    if resp.content[:2] == b'\xff\xd8':
        return resp.content
    return None


def try_token_snap(scheme):
    """Try token-based auth then POST snap."""
    login_url = f"{scheme}://{REOLINK_HOST}/api.cgi?cmd=Login"
    login_body = [{"cmd": "Login", "action": 0, "param": {
        "User": {"userName": REOLINK_USER, "password": REOLINK_PASS}
    }}]
    resp = requests.post(login_url, json=login_body, timeout=10, verify=False)
    resp.raise_for_status()
    result = resp.json()

    token = None
    if isinstance(result, list) and len(result) > 0:
        token = result[0].get("value", {}).get("Token", {}).get("name")

    if not token:
        return None

    snap_url = f"{scheme}://{REOLINK_HOST}/cgi-bin/api.cgi?cmd=Snap&channel=0&token={token}"
    resp = requests.get(snap_url, timeout=10, verify=False)
    resp.raise_for_status()

    if resp.content[:2] == b'\xff\xd8':
        return resp.content
    return None


def main():
    print(f"Connecting to Reolink camera at {REOLINK_HOST}...")

    jpeg_data = None

    # Try both HTTP and HTTPS, direct and token auth
    for scheme in ["https", "http"]:
        if jpeg_data:
            break
        try:
            jpeg_data = try_direct_snap(scheme)
            if jpeg_data:
                print(f"Got snapshot via {scheme} direct auth.")
        except Exception as e:
            print(f"{scheme} direct auth failed: {e}")

        if not jpeg_data:
            try:
                jpeg_data = try_token_snap(scheme)
                if jpeg_data:
                    print(f"Got snapshot via {scheme} token auth.")
            except Exception as e:
                print(f"{scheme} token auth failed: {e}")

    if not jpeg_data:
        print("Error: Could not get snapshot from camera.")
        print(f"  Check credentials: user={REOLINK_USER}")
        print(f"  Try visiting http://{REOLINK_HOST} in your browser to verify access.")
        return

    with open(SNAPSHOT_FILE, "wb") as f:
        f.write(jpeg_data)

    meta = {"updated": datetime.now().isoformat()}
    with open(META_FILE, "w") as f:
        json.dump(meta, f, indent=2)

    size_kb = len(jpeg_data) / 1024
    print(f"Saved snapshot ({size_kb:.0f} KB) to {SNAPSHOT_FILE}")


if __name__ == "__main__":
    main()
