"""
SolArk Cloud → Supabase Data Scraper
Logs into SolArkCloud API, pulls solar data, and pushes it to Supabase.
Designed to run as a GitHub Action on a schedule.
"""

import os
import sys
import json
import requests
from datetime import datetime, timedelta

# =============================================================
# Configuration - these come from GitHub Secrets
# =============================================================
SOLARK_USERNAME = os.environ.get("SOLARK_USERNAME")
SOLARK_PASSWORD = os.environ.get("SOLARK_PASSWORD")
SOLARK_PLANT_ID = os.environ.get("SOLARK_PLANT_ID", "159569")
SOLARK_INVERTER_SN = os.environ.get("SOLARK_INVERTER_SN", "2505109485")

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")  # Use service role key

SOLARK_API = "https://api.solarkcloud.com"


def log(msg):
    """Simple logging with timestamp."""
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def solark_login():
    """Log into SolArkCloud and get an access token."""
    log("Logging into SolArkCloud...")
    resp = requests.post(
        f"{SOLARK_API}/oauth/token",
        json={
            "username": SOLARK_USERNAME,
            "password": SOLARK_PASSWORD,
            "grant_type": "password",
            "client_id": "csp-web",
        },
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("code") != 0 or not data.get("success"):
        raise Exception(f"Login failed: {data.get('msg', 'Unknown error')}")

    token = data["data"]["access_token"]
    log("Login successful!")
    return token


def solark_get(token, endpoint):
    """Make an authenticated GET request to SolArkCloud API."""
    resp = requests.get(
        f"{SOLARK_API}{endpoint}",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )
    resp.raise_for_status()
    data = resp.json()

    if data.get("code") != 0:
        raise Exception(f"API error on {endpoint}: {data.get('msg', 'Unknown')}")

    return data.get("data", {})


def supabase_upsert(table, rows):
    """Upsert rows into a Supabase table."""
    if not rows:
        log(f"  No rows to upsert into {table}")
        return

    resp = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        json=rows,
        headers={
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
    )

    if resp.status_code not in (200, 201):
        log(f"  Supabase error ({resp.status_code}): {resp.text[:200]}")
    else:
        log(f"  Upserted {len(rows)} rows into {table}")


def fetch_daily_flow(token, date_str):
    """Fetch the energy flow data for a specific date."""
    log(f"Fetching flow data for {date_str}...")
    data = solark_get(token, f"/api/v1/plant/energy/{SOLARK_PLANT_ID}/flow?date={date_str}")
    return data


def fetch_realtime(token):
    """Fetch realtime inverter data."""
    log("Fetching realtime data...")
    data = solark_get(token, f"/api/v1/plant/energy/{SOLARK_PLANT_ID}/realtime?id={SOLARK_PLANT_ID}")
    return data


def fetch_day_energy(token, date_str):
    """Fetch detailed day energy data (the graph data with 5-min intervals)."""
    log(f"Fetching day energy for {date_str}...")
    data = solark_get(token, f"/api/v1/plant/energy/{SOLARK_PLANT_ID}/day?lan=en&date={date_str}&id={SOLARK_PLANT_ID}")
    return data


def process_day_data(date_str, day_data):
    """Process the day energy data into rows for solar_readings table."""
    rows = []

    if not day_data or not isinstance(day_data, dict):
        log(f"  No day data for {date_str}")
        return rows

    # The API typically returns data as arrays of values with timestamps
    # Structure varies but commonly has: pvPower, batteryPower, gridPower, loadPower, batterySoc
    infos = day_data if isinstance(day_data, list) else day_data.get("infos", [])

    if isinstance(day_data, dict):
        # Try to extract time-series data from various possible formats
        pv = day_data.get("pvPower", day_data.get("pv", []))
        battery = day_data.get("batteryPower", day_data.get("battery", []))
        grid = day_data.get("gridPower", day_data.get("grid", []))
        load = day_data.get("loadPower", day_data.get("load", []))
        soc = day_data.get("batterySoc", day_data.get("soc", []))

        # If data comes as list of {time, value} objects
        if pv and isinstance(pv, list) and len(pv) > 0:
            if isinstance(pv[0], dict):
                for i, entry in enumerate(pv):
                    time_val = entry.get("time", entry.get("x", ""))
                    row = {
                        "reading_date": date_str,
                        "reading_time": time_val,
                        "pv_watts": entry.get("value", entry.get("y", 0)) or 0,
                        "battery_watts": _get_val(battery, i),
                        "battery_soc": _get_val(soc, i),
                        "grid_watts": _get_val(grid, i),
                        "load_watts": _get_val(load, i),
                    }
                    rows.append(row)
            else:
                # Data might be simple arrays matched by index
                log(f"  Data format: simple arrays (len={len(pv)})")

    # If we got infos as a list of complete records
    if not rows and infos and isinstance(infos, list):
        for entry in infos:
            if isinstance(entry, dict):
                time_val = entry.get("time", entry.get("dateTime", ""))
                if "T" in str(time_val):
                    time_val = str(time_val).split("T")[1][:5]
                rows.append({
                    "reading_date": date_str,
                    "reading_time": time_val,
                    "pv_watts": entry.get("pvPower", entry.get("pv", 0)) or 0,
                    "battery_watts": entry.get("batteryPower", entry.get("battery", 0)) or 0,
                    "battery_soc": entry.get("batterySoc", entry.get("soc", 0)) or 0,
                    "grid_watts": entry.get("gridPower", entry.get("grid", 0)) or 0,
                    "load_watts": entry.get("loadPower", entry.get("load", 0)) or 0,
                })

    log(f"  Processed {len(rows)} readings for {date_str}")
    return rows


def _get_val(data_list, index):
    """Safely get a value from a list at a given index."""
    if not data_list or index >= len(data_list):
        return 0
    item = data_list[index]
    if isinstance(item, dict):
        return item.get("value", item.get("y", 0)) or 0
    return item or 0


def process_realtime(realtime_data):
    """Process realtime data into a row for solar_realtime table."""
    if not realtime_data or not isinstance(realtime_data, dict):
        return None

    return {
        "pv_watts": realtime_data.get("pac", realtime_data.get("pvPower", 0)) or 0,
        "battery_watts": realtime_data.get("batteryPower", 0) or 0,
        "battery_soc": realtime_data.get("batterySoc", realtime_data.get("soc", 0)) or 0,
        "grid_watts": realtime_data.get("gridOrMeterPower", realtime_data.get("gridPower", 0)) or 0,
        "load_watts": realtime_data.get("loadOrEpsPower", realtime_data.get("loadPower", 0)) or 0,
        "inverter_status": realtime_data.get("status", None),
        "raw_data": json.dumps(realtime_data),
    }


def compute_daily_summary(date_str, readings):
    """Compute a daily summary from the detailed readings."""
    if not readings:
        return None

    pv_values = [r["pv_watts"] for r in readings]
    load_values = [r["load_watts"] for r in readings]
    battery_values = [r["battery_watts"] for r in readings]
    grid_values = [r["grid_watts"] for r in readings]

    # Rough kWh estimate: sum of watts * (interval in hours)
    # Flow data is typically every 5 minutes = 1/12 hour
    interval_hours = 5 / 60

    return {
        "summary_date": date_str,
        "pv_kwh": round(sum(max(v, 0) for v in pv_values) * interval_hours / 1000, 2),
        "battery_charge_kwh": round(sum(max(v, 0) for v in battery_values) * interval_hours / 1000, 2),
        "battery_discharge_kwh": round(sum(abs(min(v, 0)) for v in battery_values) * interval_hours / 1000, 2),
        "grid_import_kwh": round(sum(max(v, 0) for v in grid_values) * interval_hours / 1000, 2),
        "grid_export_kwh": round(sum(abs(min(v, 0)) for v in grid_values) * interval_hours / 1000, 2),
        "load_kwh": round(sum(max(v, 0) for v in load_values) * interval_hours / 1000, 2),
        "peak_pv_watts": max(pv_values) if pv_values else 0,
        "peak_load_watts": max(load_values) if load_values else 0,
    }


def run_scraper(days_back=1):
    """Main scraper logic."""
    log("=" * 50)
    log("SolArk → Supabase Scraper Starting")
    log("=" * 50)

    # Validate env vars
    missing = []
    if not SOLARK_USERNAME:
        missing.append("SOLARK_USERNAME")
    if not SOLARK_PASSWORD:
        missing.append("SOLARK_PASSWORD")
    if not SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SUPABASE_KEY:
        missing.append("SUPABASE_SERVICE_KEY")

    if missing:
        log(f"ERROR: Missing environment variables: {', '.join(missing)}")
        sys.exit(1)

    # Step 1: Login
    token = solark_login()

    # Step 2: Fetch and store realtime data
    try:
        realtime = fetch_realtime(token)
        realtime_row = process_realtime(realtime)
        if realtime_row:
            supabase_upsert("solar_realtime", [realtime_row])
    except Exception as e:
        log(f"Warning: Could not fetch realtime data: {e}")

    # Step 3: Fetch historical day data
    today = datetime.now()
    for i in range(days_back):
        target_date = today - timedelta(days=i)
        date_str = target_date.strftime("%Y-%m-%d")

        try:
            day_data = fetch_day_energy(token, date_str)

            # Debug: log the raw structure so we can see what the API returns
            if day_data:
                if isinstance(day_data, dict):
                    log(f"  Day data keys: {list(day_data.keys())[:10]}")
                elif isinstance(day_data, list):
                    log(f"  Day data: list with {len(day_data)} items")

            readings = process_day_data(date_str, day_data)

            if readings:
                supabase_upsert("solar_readings", readings)

                summary = compute_daily_summary(date_str, readings)
                if summary:
                    supabase_upsert("solar_daily_summary", [summary])

        except Exception as e:
            log(f"Warning: Could not fetch data for {date_str}: {e}")

    # Step 4: Also try the flow endpoint for today
    try:
        date_str = today.strftime("%Y-%m-%d")
        flow_data = fetch_daily_flow(token, date_str)
        if flow_data:
            log(f"  Flow data keys: {list(flow_data.keys())[:10] if isinstance(flow_data, dict) else 'not a dict'}")
            # Store raw flow data as a realtime snapshot too
            flow_row = process_realtime(flow_data)
            if flow_row:
                supabase_upsert("solar_realtime", [flow_row])
    except Exception as e:
        log(f"Warning: Could not fetch flow data: {e}")

    log("=" * 50)
    log("Scraper complete!")
    log("=" * 50)


if __name__ == "__main__":
    # Default: fetch today + yesterday
    # Pass a number to fetch more days back (e.g., 30 for backfill)
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    run_scraper(days_back=days)
