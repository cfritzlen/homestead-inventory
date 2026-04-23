"""Export all data from Supabase to local JSON files for NAS migration."""

import requests
import json
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORT_DIR = os.path.join(SCRIPT_DIR, "exported-data")

SUPABASE_URL = "https://jzpipxvxrtdhmsdkveog.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6cGlweHZ4cnRkaG1zZGt2ZW9nIiwi"
    "cm9sZSI6ImFub24iLCJpYXQiOjE3Njk3NTE1MjUsImV4cCI6MjA4NTMyNzUyNX0."
    "7mm0ts91y0leGKLFCgRk6KJitah3V5WJZdiD_gHL57o"
)

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Accept": "application/json",
}

TABLES = [
    "solar_readings",
    "solar_daily_summary",
    "solar_realtime",
    "solar_electric_bills",
    "meds",
    "med_logs",
    "bp_readings",
    "med_notes",
    "sleep_entries",
    "recipes",
    "master_items",
    "recipe_ingredients",
    "recipe_steps",
    "meal_plan",
    "shopping_list",
    "inventory",
    "home_vendors",
    "home_expenses",
    "home_expense_receipts",
    "finance_transactions",
    "hatching_batches",
    "homestead_chores",
    "plant_entries",
    "plant_photos",
    "harvest_log",
    "brain_topics",
    "brain_people",
    "brain_tags",
    "brain_documents",
    "brain_memories",
    "prediction_trades",
]


def export_table(table_name):
    """Export a table with pagination (Supabase limits to 1000 rows per request)."""
    all_rows = []
    offset = 0
    limit = 1000

    while True:
        url = f"{SUPABASE_URL}/rest/v1/{table_name}?select=*&limit={limit}&offset={offset}"
        resp = requests.get(url, headers=HEADERS)

        if resp.status_code == 404:
            print(f"  {table_name}: TABLE NOT FOUND (skipping)")
            return None
        if resp.status_code != 200:
            print(f"  {table_name}: ERROR {resp.status_code} — {resp.text[:100]}")
            return None

        rows = resp.json()
        all_rows.extend(rows)

        if len(rows) < limit:
            break
        offset += limit

    return all_rows


def main():
    os.makedirs(EXPORT_DIR, exist_ok=True)

    print("Exporting Supabase data...")
    print(f"Output: {EXPORT_DIR}\n")

    summary = {}

    for table in TABLES:
        rows = export_table(table)
        if rows is None:
            summary[table] = "SKIPPED"
            continue

        filepath = os.path.join(EXPORT_DIR, f"{table}.json")
        with open(filepath, "w") as f:
            json.dump(rows, f, indent=2, default=str)

        summary[table] = len(rows)
        print(f"  {table}: {len(rows)} rows")

    print(f"\n{'='*50}")
    print("EXPORT COMPLETE")
    print(f"{'='*50}")
    total = sum(v for v in summary.values() if isinstance(v, int))
    print(f"Total rows exported: {total}")
    skipped = [k for k, v in summary.items() if v == "SKIPPED"]
    if skipped:
        print(f"Skipped tables: {', '.join(skipped)}")
    print(f"\nFiles saved to: {EXPORT_DIR}")


if __name__ == "__main__":
    main()
