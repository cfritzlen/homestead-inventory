"""
Daily rent check: did each tenant's Zelle rent payment come in this month?

Reads the same tables rentals.html uses (rental_payment_defaults,
rental_payments, rental_rate_schedules) plus the bank transactions imported
on the Finances page (finance_transactions), matches Zelle credits to
tenants by name, and emails a short status via Resend — the same service
the MX listings digest uses.

Only sends when there's something to say: rent still unpaid, or a Zelle
payment sitting in the bank import that hasn't been recorded yet. When
every rent is recorded, it stays quiet (set RENT_CHECK_ALWAYS=true to get
the all-clear email too).

Env vars:
  SUPABASE_SERVICE_ROLE_KEY — required (Supabase → Settings → API)
  RESEND_API_KEY            — required
  RENT_CHECK_TO_EMAIL       — recipient (falls back to MX_LISTINGS_TO_EMAIL)
  RENT_CHECK_FROM_EMAIL     — optional, defaults to onboarding@resend.dev
  RENT_CHECK_ALWAYS         — optional, "true" = email even when all paid

Usage:
  python rent_check.py            # send via Resend
  python rent_check.py --dry-run  # print the email HTML to ./out/rent-check.html
"""
import argparse
import datetime as dt
import os
import re
import sys
from pathlib import Path

import requests

SUPABASE_URL = "https://jzpipxvxrtdhmsdkveog.supabase.co"
OUT_DIR = Path(__file__).resolve().parent / "out"


def supa_get(table: str, params: list) -> list:
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    r = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        params=params,
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def month_window(today: dt.date):
    start = today.replace(day=1)
    end = (start + dt.timedelta(days=32)).replace(day=1)
    return start, end


def amount_for_month(default_id, month_start, rate_schedules, defaults_by_id) -> float:
    # Mirror of getAmountForMonth() in rentals.html: most recent rate on or
    # before the 1st of the month, else the default amount.
    rates = sorted(
        (r for r in rate_schedules if r["payment_default_id"] == default_id),
        key=lambda r: r["effective_date"],
        reverse=True,
    )
    for rate in rates:
        if rate["effective_date"] <= month_start.isoformat():
            return float(rate["amount"])
    d = defaults_by_id.get(default_id)
    return float(d["default_amount"]) if d else 0.0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    today = dt.date.today()
    start, end = month_window(today)
    period = start.strftime("%Y-%m")

    defaults = supa_get(
        "rental_payment_defaults",
        [("select", "*"), ("status", "eq.active"), ("type", "eq.rent")],
    )
    if not defaults:
        print("No active rent defaults set up — nothing to check.")
        return
    defaults_by_id = {d["id"]: d for d in defaults}

    payments = supa_get(
        "rental_payments", [("select", "*"), ("period", f"eq.{period}")]
    )
    rate_schedules = supa_get("rental_rate_schedules", [("select", "*")])
    txns = supa_get(
        "finance_transactions",
        [
            ("select", "id,transaction_date,description,amount,category"),
            ("transaction_date", f"gte.{start.isoformat()}"),
            ("transaction_date", f"lt.{end.isoformat()}"),
            ("amount", "gt.0"),
            # PostgREST: * is the ilike wildcard when sent unencoded via params
            ("or", '(description.ilike.*zelle*,category.eq."Rent Payment")'),
        ],
    )

    paid, unrecorded, missing = [], [], []
    used_txns = set()

    for d in defaults:
        owed = amount_for_month(d["id"], start, rate_schedules, defaults_by_id)
        pay = next((p for p in payments if p["payment_default_id"] == d["id"]), None)
        is_paid = pay and float(pay.get("amount_paid") or 0) >= float(
            pay.get("amount_owed") or owed or 0
        )

        words = [w for w in re.split(r"[^a-z]+", (d["label"] or "").lower()) if len(w) > 2]
        match = next(
            (
                t
                for t in txns
                if t["id"] not in used_txns
                and any(w in (t["description"] or "").lower() for w in words)
            ),
            None,
        )
        if match:
            used_txns.add(match["id"])

        if is_paid:
            paid.append((d, pay))
        elif match:
            unrecorded.append((d, match))
        else:
            missing.append((d, owed))

    always = os.environ.get("RENT_CHECK_ALWAYS", "").lower() == "true"
    if not unrecorded and not missing and not always:
        print(f"All {len(paid)} rents recorded for {period} — no email needed.")
        return

    month_name = start.strftime("%B %Y")
    rows = []
    for d, t in unrecorded:
        rows.append(
            f'<li>⚡ <b>{d["label"]}</b> — Zelle <b>${float(t["amount"]):,.2f}</b> '
            f'arrived {t["transaction_date"]} but isn\'t recorded yet. '
            f'Open the Rentals page → Payments → "Scan This Month" to record it.</li>'
        )
    for d, owed in missing:
        due = f' (due day {d["due_day"]})' if d.get("due_day") else ""
        rows.append(
            f'<li>⚠️ <b>{d["label"]}</b> — no Zelle payment found this month, '
            f"expecting <b>${owed:,.2f}</b>{due}.</li>"
        )
    for d, pay in paid:
        when = pay.get("date_paid") or "—"
        rows.append(
            f'<li>✅ <b>{d["label"]}</b> — paid '
            f'${float(pay.get("amount_paid") or 0):,.2f} on {when}.</li>'
        )

    html = (
        f"<h2>🏘️ Rent check — {month_name}</h2>"
        f"<ul>{''.join(rows)}</ul>"
        f'<p style="color:#666;font-size:13px;">Tip: import your latest bank CSV on '
        f"the Finances page so this check sees the newest Zelle payments.</p>"
    )
    n_issues = len(unrecorded) + len(missing)
    subject = (
        f"Rent check {month_name}: all {len(paid)} paid 🎉"
        if n_issues == 0
        else f"Rent check {month_name}: {n_issues} need attention"
    )

    if args.dry_run:
        OUT_DIR.mkdir(exist_ok=True)
        out = OUT_DIR / "rent-check.html"
        out.write_text(f"<title>{subject}</title>{html}")
        print(f"Dry run — wrote {out}")
        return

    api_key = os.environ.get("RESEND_API_KEY")
    to_addr = os.environ.get("RENT_CHECK_TO_EMAIL") or os.environ.get("MX_LISTINGS_TO_EMAIL")
    from_addr = os.environ.get("RENT_CHECK_FROM_EMAIL", "onboarding@resend.dev")
    if not api_key or not to_addr:
        print("ERROR: RESEND_API_KEY and RENT_CHECK_TO_EMAIL must be set", file=sys.stderr)
        sys.exit(1)

    r = requests.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"from": from_addr, "to": [to_addr], "subject": subject, "html": html},
        timeout=30,
    )
    if r.status_code >= 300:
        print(f"ERROR: Resend returned {r.status_code}: {r.text}", file=sys.stderr)
        sys.exit(1)
    print(f"Sent: {subject} → {to_addr}")


if __name__ == "__main__":
    main()
