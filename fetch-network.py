"""Fetch UniFi client data and save as JSON for the network dashboard."""

import requests
import urllib3
import json
import os
from datetime import datetime

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

UNIFI_HOST = os.environ.get("UNIFI_HOST", "192.168.1.1")
API_KEY = os.environ.get("UNIFI_API_KEY", "")
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "network-data.json")


def main():
    if not API_KEY:
        print("Error: Set UNIFI_API_KEY environment variable")
        return

    url = f"https://{UNIFI_HOST}/proxy/network/api/s/default/stat/sta"
    headers = {"X-API-KEY": API_KEY, "Accept": "application/json"}

    resp = requests.get(url, headers=headers, verify=False, timeout=10)
    resp.raise_for_status()

    clients = resp.json().get("data", [])

    # Extract only the fields the dashboard needs
    clean = []
    for c in clients:
        clean.append({
            "hostname": c.get("hostname") or c.get("name") or c.get("oui") or "Unknown",
            "ip": c.get("ip", ""),
            "mac": c.get("mac", ""),
            "is_wired": c.get("is_wired", False),
            "signal": c.get("signal"),
            "tx_bytes": c.get("tx_bytes", 0),
            "rx_bytes": c.get("rx_bytes", 0),
            "uptime": c.get("uptime", 0),
        })

    output = {
        "updated": datetime.now().isoformat(),
        "clients": clean
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Saved {len(clean)} clients to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
