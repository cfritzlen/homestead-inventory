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
    """Fetch realtime inverter data from the flow endpoint (today's snapshot)."""
    log("Fetching realtime data via flow endpoint...")
    date_str = datetime.now().strftime("%Y-%m-%d")
    data = solark_get(token, f"/api/v1/plant/energy/{SOLARK_PLANT_ID}/flow?date={date_str}")
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

    infos = day_data.get("infos", [])

    # Debug: log the first info entry to understand the structure
    if infos and len(infos) > 0:
        log(f"  First info entry keys: {list(infos[0].keys()) if isinstance(infos[0], dict) else type(infos[0])}")
        log(f"  First info entry sample: {json.dumps(infos[0])[:300]}")

    for entry in infos:
        if not isinstance(entry, dict):
            continue

        # Extract time - try multiple possible field names
        time_val = (
            entry.get("time", "") or
            entry.get("dateTime", "") or
            entry.get("dataTime", "") or
            entry.get("hourTime", "") or
            ""
        )

        # Convert datetime string to just time if needed
        if "T" in str(time_val):
            time_val = str(time_val).split("T")[1][:8]

        # Skip entries with no valid time
        if not time_val or time_val.strip() == "":
            # Try to construct time from other fields
            hour = entry.get("hour", entry.get("h", None))
            minute = entry.get("minute", entry.get("m", entry.get("min", None)))
            if hour is not None:
                minute = minute if minute is not None else 0
                time_val = f"{int(hour):02d}:{int(minute):02d}:00"
            else:
                continue  # Skip if we truly can't determine the time

        # Ensure time has seconds
        if len(time_val) == 5:  # HH:MM
            time_val = time_val + ":00"

        rows.append({
            "reading_date": date_str,
            "reading_time": time_val,
            "pv_watts": float(entry.get("pvPower", entry.get("pv", entry.get("pvW", 0))) or 0),
            "battery_watts": float(entry.get("batteryPower", entry.get("battPower", entry.get("battery", 0))) or 0),
            "battery_soc": float(entry.get("batterySoc", entry.get("soc", entry.get("battSoc", 0))) or 0),
            "grid_watts": float(entry.get("gridPower", entry.get("gridOrMeterPower", entry.get("grid", 0))) or 0),
            "load_watts": float(entry.get("loadPower", entry.get("loadOrEpsPower", entry.get("load", 0))) or 0),
        })

    log(f"  Processed {len(rows)} readings for {date_str}")
    return rows


def process_realtime(realtime_data):
    """Process realtime/flow data into a row for solar_realtime table."""
    if not realtime_data or not isinstance(realtime_data, dict):
        return None

    return {
        "pv_watts": float(realtime_data.get("pvPower", realtime_data.get("pv", 0)) or 0),
        "battery_watts": float(realtime_data.get("battPower", realtime_data.get("batteryPower", 0)) or 0),
        "battery_soc": float(realtime_data.get("soc", realtime_data.get("batterySoc", 0)) or 0),
        "grid_watts": float(realtime_data.get("gridOrMeterPower", realtime_data.get("gridPower", 0)) or 0),
        "load_watts": float(realtime_data.get("loadOrEpsPower", realtime_data.get("loadPower", 0)) or 0),
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


def compute_summary_from_flow(date_str, flow_data):
    """
    Compute daily summary directly from the flow endpoint data.
    The flow endpoint returns cumulative totals, not intervals.
    """
    if not flow_data or not isinstance(flow_data, dict):
        return None

    # The flow endpoint often has cumulative energy values
    # Look for fields like etoday, etodayFrom, etodayTo, etc.
    log(f"  Flow data all keys: {list(flow_data.keys())}")

    # Try to extract daily totals directly
    pv_kwh = float(flow_data.get("pvToday", flow_data.get("pvEtoday", flow_data.get("etoday", 0))) or 0)
    load_kwh = float(flow_data.get("loadToday", flow_data.get("useEtoday", 0)) or 0)
    grid_import = float(flow_data.get("gridImportToday", flow_data.get("buyToday", flow_data.get("toBuyToday", 0))) or 0)
    grid_export = float(flow_data.get("gridExportToday", flow_data.get("sellToday", flow_data.get("toSellToday", 0))) or 0)
    batt_charge = float(flow_data.get("batteryChargeToday", flow_data.get("chgToday", 0)) or 0)
    batt_discharge = float(flow_data.get("batteryDischargeToday", flow_data.get("dischgToday", 0)) or 0)

    # If we got any non-zero values, return a summary
    if any([pv_kwh, load_kwh, grid_import, grid_export, batt_charge, batt_discharge]):
        log(f"  Flow summary: pv={pv_kwh}, load={load_kwh}, import={grid_import}, export={grid_export}")
        return {
            "summary_date": date_str,
            "pv_kwh": round(pv_kwh, 2),
            "battery_charge_kwh": round(batt_charge, 2),
            "battery_discharge_kwh": round(batt_discharge, 2),
            "grid_import_kwh": round(grid_import, 2),
            "grid_export_kwh": round(grid_export, 2),
            "load_kwh": round(load_kwh, 2),
            "peak_pv_watts": 0,
            "peak_load_watts": 0,
        }

    return None


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

    # Step 2: Fetch and store realtime data via flow endpoint
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
            # Try the day energy endpoint first (detailed interval data)
            day_data = fetch_day_energy(token, date_str)

            if day_data:
                if isinstance(day_data, dict):
                    log(f"  Day data keys: {list(day_data.keys())[:10]}")

            readings = process_day_data(date_str, day_data)

            if readings:
                supabase_upsert("solar_readings", readings)
                summary = compute_daily_summary(date_str, readings)
                if summary:
                    supabase_upsert("solar_daily_summary", [summary])
            else:
                log(f"  No interval readings, trying flow endpoint for daily totals...")

            # Also try the flow endpoint for daily totals
            try:
                flow_data = fetch_daily_flow(token, date_str)
                if flow_data:
                    flow_summary = compute_summary_from_flow(date_str, flow_data)
                    if flow_summary:
                        supabase_upsert("solar_daily_summary", [flow_summary])
                    
                    # Store as realtime snapshot too (for today only)
                    if i == 0:
                        flow_row = process_realtime(flow_data)
                        if flow_row:
                            supabase_upsert("solar_realtime", [flow_row])
            except Exception as e:
                log(f"  Warning: Flow endpoint failed for {date_str}: {e}")

        except Exception as e:
            log(f"Warning: Could not fetch data for {date_str}: {e}")

    log("=" * 50)
    log("Scraper complete!")
    log("=" * 50)


if __name__ == "__main__":
    # Default: fetch today + yesterday
    # Pass a number to fetch more days back (e.g., 30 for backfill)
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    run_scraper(days_back=days)
