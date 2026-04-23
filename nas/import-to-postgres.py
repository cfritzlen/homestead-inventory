"""Import exported Supabase JSON data into local PostgreSQL."""

import json
import os
import psycopg2
from psycopg2.extras import execute_values

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EXPORT_DIR = os.path.join(SCRIPT_DIR, "exported-data")

DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = os.environ.get("DB_PORT", "5432")
DB_NAME = os.environ.get("DB_NAME", "homestead")
DB_USER = os.environ.get("DB_USER", "homestead")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")

# Import order respects foreign key dependencies
IMPORT_ORDER = [
    # No dependencies
    "solar_readings",
    "solar_daily_summary",
    "solar_realtime",
    "solar_electric_bills",
    "meds",
    "med_logs",
    "bp_readings",
    "med_notes",
    "sleep_entries",
    "shopping_list",
    "inventory",
    "home_vendors",
    "master_items",
    "brain_topics",
    "brain_people",
    "brain_tags",
    "hatching_batches",
    "homestead_chores",
    "plant_entries",
    "finance_transactions",
    "prediction_trades",
    # Has dependencies
    "recipes",
    "recipe_ingredients",
    "recipe_steps",
    "meal_plan",
    "home_expenses",
    "home_expense_receipts",
    "plant_photos",
    "harvest_log",
    "brain_documents",
    "brain_memories",
]


def import_table(cursor, table_name, rows):
    """Insert rows into a table."""
    if not rows:
        return 0

    columns = list(rows[0].keys())
    col_list = ", ".join(f'"{c}"' for c in columns)
    placeholders = ", ".join(["%s"] * len(columns))

    # Use ON CONFLICT DO NOTHING to handle duplicates gracefully
    sql = f'INSERT INTO {table_name} ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING'

    values = []
    for row in rows:
        vals = []
        for col in columns:
            v = row[col]
            # Convert Python lists/dicts to JSON strings for JSONB columns
            if isinstance(v, (list, dict)):
                v = json.dumps(v)
            vals.append(v)
        values.append(tuple(vals))

    cursor.executemany(sql, values)
    return len(values)


def main():
    if not DB_PASSWORD:
        print("Error: Set DB_PASSWORD environment variable")
        return

    if not os.path.isdir(EXPORT_DIR):
        print(f"Error: No exported data found at {EXPORT_DIR}")
        print("Run export-supabase.py first.")
        return

    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT,
        dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    cursor = conn.cursor()

    print("Importing data into PostgreSQL...")
    print(f"Database: {DB_USER}@{DB_HOST}:{DB_PORT}/{DB_NAME}\n")

    total = 0
    for table in IMPORT_ORDER:
        filepath = os.path.join(EXPORT_DIR, f"{table}.json")
        if not os.path.exists(filepath):
            print(f"  {table}: no export file (skipping)")
            continue

        with open(filepath) as f:
            rows = json.load(f)

        if not rows:
            print(f"  {table}: 0 rows (empty)")
            continue

        try:
            count = import_table(cursor, table, rows)
            conn.commit()
            print(f"  {table}: {count} rows imported")
            total += count
        except Exception as e:
            conn.rollback()
            print(f"  {table}: ERROR — {e}")

    cursor.close()
    conn.close()

    print(f"\n{'='*50}")
    print(f"IMPORT COMPLETE — {total} total rows")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
