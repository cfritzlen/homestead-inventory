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

SOLARK_USERNAME = os.environ.get("SOLARK_USERNAME")
SOLARK_PASSWORD = os.environ.get("SOLARK_PASSWORD")
SOLARK_PLANT_ID = os.environ.get("SOLARK_PLANT_ID", "159569")
SOLARK_INVERTER_SN = os.environ.get("SOLARK_INVERTER_SN", "2505109485")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
SOLARK_API = "https://api.solarkcloud.com"


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def solark_login():
    log("Logging into SolArkCloud...")
    resp = requests.post(f"{SOLARK_API}/oauth/token", json={
        "username": SOLARK_USERNAME, "password": SOLARK_PASSWORD,
        "grant_type": "password", "client_id": "csp-web",
    }, headers={"Content-Type": "application/json", "Accept": "application/json"})
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 0:
        raise Exception(f"Login failed: {data.get('msg')}")
    log("Login successful!")
    return data["data"]["access_token"]


def solark_get(token, endpoint):
    resp = requests.get(f"{SOLARK_API}{endpoint}", headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json"})
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 0:
        raise Exception(f"API error on {endpoint}: {data.get('msg')}")
    return data.get("data", {})


def supabase_upsert(table, rows):
    if not rows:
        return
    resp = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", json=rows, headers={
        "apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"})
    if resp.status_code not in (200, 201):
        log(f"  Supabase error ({resp.status_code}): {resp.text[:200]}")
    else:
        log(f"  Upserted {len(rows)} rows into {table}")


def fetch_flow(token, date_str):
    data = solark_get(token, f"/api/v1/plant/energy/{SOLARK_PLANT_ID}/flow?date={date_str}")
    return data


def fetch_day_energy(token, date_str):
    data = solark_get(token, f"/api/v1/plant/energy/{SOLARK_PLANT_ID}/day?lan=en&date={date_str}&id={SOLARK_PLANT_ID}")
    return data


def classify_metric(info):
    """Figure out what metric an info entry represents."""
    name = (info.get("name") or info.get("label") or "").lower()
    group = (info.get("groupCode") or "").lower()
    combined = name + " " + group
    if "soc" in combined or "state of charge" in combined:
        return "soc"
    if "pv" in combined or "solar" in combined:
        return "pv"
    if "batt" in combined:
        return "battery"
    if "grid" in combined or "meter" in combined:
        return "grid"
    if "load" in combined or "eps" in combined or "consumption" in combined or "home" in combined:
        return "load"
    return None


def process_day_data(date_str, day_data):
    """
    Process day energy data. API returns:
    infos: [
        { name: "PV Power", unit: "W", groupCode: "...",
          records: [{time: "00:00", value: "0.0"}, ...] },
        ...
    ]
    """
    rows = []
    if not day_data or not isinstance(day_data, dict):
        return rows

    infos = day_data.get("infos", [])
    if not infos:
        return rows

    # Classify each metric
    metrics = {}
    for info in infos:
        if not isinstance(info, dict):
            continue
        metric_type = classify_metric(info)
        name = info.get("name") or info.get("label") or "?"
        records = info.get("records", [])
        log(f"    Metric: '{name}' (group={info.get('groupCode','?')}) -> {metric_type or 'UNKNOWN'} ({len(records)} records)")
        if metric_type and records:
            metrics[metric_type] = records

    # Find time base
    time_base = None
    for key in ["load", "grid", "pv", "battery", "soc"]:
        if key in metrics and metrics[key]:
            time_base = metrics[key]
            break

    if not time_base:
        return rows

    # Build rows
    for i, record in enumerate(time_base):
        time_val = record.get("time", "")
        if not time_val:
            continue
        if len(time_val) == 5:
            time_val += ":00"

        def val(mk):
            recs = metrics.get(mk, [])
            if i < len(recs):
                try:
                    return float(recs[i].get("value", 0) or 0)
                except (ValueError, TypeError):
                    return 0.0
            return 0.0

        rows.append({
            "reading_date": date_str,
            "reading_time": time_val,
            "pv_watts": val("pv"),
            "battery_watts": val("battery"),
            "battery_soc": val("soc"),
            "grid_watts": val("grid"),
            "load_watts": val("load"),
        })

    nonzero = sum(1 for r in rows if any([r["pv_watts"], r["load_watts"], r["grid_watts"], r["battery_watts"]]))
    log(f"  Total readings: {len(rows)}, with data: {nonzero}")
    return rows


def process_realtime(flow_data):
    if not flow_data or not isinstance(flow_data, dict):
        return None
    interesting = {k: v for k, v in flow_data.items() if isinstance(v, (int, float)) and v != 0}
    if interesting:
        log(f"  Flow non-zero values: {json.dumps(interesting)}")
    return {
        "pv_watts": float(flow_data.get("pvPower", 0) or 0),
        "battery_watts": float(flow_data.get("battPower", 0) or 0),
        "battery_soc": float(flow_data.get("soc", 0) or 0),
        "grid_watts": float(flow_data.get("gridOrMeterPower", 0) or 0),
        "load_watts": float(flow_data.get("loadOrEpsPower", 0) or 0),
        "inverter_status": flow_data.get("status", None),
        "raw_data": json.dumps(flow_data),
    }


def compute_daily_summary(date_str, readings):
    if not readings:
        return None
    pv = [r["pv_watts"] for r in readings]
    load = [r["load_watts"] for r in readings]
    batt = [r["battery_watts"] for r in readings]
    grid = [r["grid_watts"] for r in readings]
    has_data = any(v != 0 for v in pv + load + batt + grid)
    if not has_data:
        return None
    hrs = 5 / 60
    return {
        "summary_date": date_str,
        "pv_kwh": round(sum(max(v, 0) for v in pv) * hrs / 1000, 2),
        "battery_charge_kwh": round(sum(max(v, 0) for v in batt) * hrs / 1000, 2),
        "battery_discharge_kwh": round(sum(abs(min(v, 0)) for v in batt) * hrs / 1000, 2),
        "grid_import_kwh": round(sum(max(v, 0) for v in grid) * hrs / 1000, 2),
        "grid_export_kwh": round(sum(abs(min(v, 0)) for v in grid) * hrs / 1000, 2),
        "load_kwh": round(sum(max(v, 0) for v in load) * hrs / 1000, 2),
        "peak_pv_watts": max(pv) if pv else 0,
        "peak_load_watts": max(load) if load else 0,
    }


def run_scraper(days_back=1):
    log("=" * 50)
    log("SolArk -> Supabase Scraper Starting")
    log("=" * 50)

    missing = [v for v in ["SOLARK_USERNAME", "SOLARK_PASSWORD", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"]
               if not os.environ.get(v)]
    if missing:
        log(f"ERROR: Missing env vars: {', '.join(missing)}")
        sys.exit(1)

    token = solark_login()

    # Realtime
    try:
        flow = fetch_flow(token, datetime.now().strftime("%Y-%m-%d"))
        row = process_realtime(flow)
        if row:
            supabase_upsert("solar_realtime", [row])
    except Exception as e:
        log(f"Warning: Realtime failed: {e}")

    # Historical
    today = datetime.now()
    for i in range(days_back):
        date_str = (today - timedelta(days=i)).strftime("%Y-%m-%d")
        try:
            log(f"--- {date_str} ---")
            day_data = fetch_day_energy(token, date_str)
            readings = process_day_data(date_str, day_data)
            if readings:
                supabase_upsert("solar_readings", readings)
                summary = compute_daily_summary(date_str, readings)
                if summary:
                    supabase_upsert("solar_daily_summary", [summary])
                    log(f"  OK pv={summary['pv_kwh']}kWh load={summary['load_kwh']}kWh grid_in={summary['grid_import_kwh']}kWh")
                else:
                    log(f"  All values zero - no summary saved")
        except Exception as e:
            log(f"Warning: Failed for {date_str}: {e}")

    log("=" * 50)
    log("Scraper complete!")


if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    run_scraper(days_back=days)
