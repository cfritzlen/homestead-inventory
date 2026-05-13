#!/usr/bin/env python3
"""Export all finance data from Supabase and import into local PostgreSQL.

Run on the NAS after creating tables with migrate-finance-tables.sql.
Usage: python3 export-finance-from-supabase.py
"""

import json
import os
import requests
import psycopg2
import psycopg2.extras

SUPABASE_URL = "https://jzpipxvxrtdhmsdkveog.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6cGlweHZ4cnRkaG1zZGt2ZW9nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk3NTE1MjUsImV4cCI6MjA4NTMyNzUyNX0.7mm0ts91y0leGKLFCgRk6KJitah3V5WJZdiD_gHL57o"

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://homestead:homestead@localhost:5432/homestead")

TABLES = [
    "finance_accounts",
    "finance_transactions",
    "finance_bills",
    "finance_bill_payments",
    "finance_weekly_entries",
    "finance_loan_schedules",
    "finance_other_payments",
    "finance_extra_payments",
    "finance_categories",
]


def fetch_supabase(table):
    """Fetch all rows from a Supabase table."""
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
    }
    rows = []
    offset = 0
    limit = 1000
    while True:
        url = f"{SUPABASE_URL}/rest/v1/{table}?limit={limit}&offset={offset}"
        resp = requests.get(url, headers=headers)
        if resp.status_code != 200:
            print(f"  Error fetching {table}: {resp.status_code} {resp.text[:200]}")
            break
        batch = resp.json()
        if not batch:
            break
        rows.extend(batch)
        offset += limit
        if len(batch) < limit:
            break
    return rows


def insert_rows(conn, table, rows):
    """Insert rows into local PostgreSQL, skipping duplicates."""
    if not rows:
        return 0
    cur = conn.cursor()
    inserted = 0
    for row in rows:
        columns = list(row.keys())
        col_list = ", ".join(f'"{c}"' for c in columns)
        placeholders = ", ".join(["%s"] * len(columns))
        values = [json.dumps(v) if isinstance(v, (list, dict)) else v for v in row.values()]
        try:
            cur.execute(
                f'INSERT INTO {table} ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING',
                values
            )
            if cur.rowcount > 0:
                inserted += 1
        except Exception as e:
            conn.rollback()
            print(f"  Error inserting row: {e}")
            continue
    conn.commit()
    cur.close()
    return inserted


def main():
    print("=== Export Finance Data from Supabase to Local PostgreSQL ===\n")

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False

    for table in TABLES:
        print(f"Fetching {table}...")
        rows = fetch_supabase(table)
        print(f"  Got {len(rows)} rows")

        if rows:
            inserted = insert_rows(conn, table, rows)
            print(f"  Inserted {inserted}, skipped {len(rows) - inserted} duplicates")
        else:
            print("  No data")

    conn.close()
    print("\nDone! Finance data migrated to local PostgreSQL.")


if __name__ == "__main__":
    main()
