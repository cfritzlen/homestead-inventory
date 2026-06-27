"""
Send the digest via Resend (https://resend.com).

Free tier: 100 emails/month, no credit card.
Env vars:
  RESEND_API_KEY        — required
  MX_LISTINGS_TO_EMAIL  — recipient
  MX_LISTINGS_FROM_EMAIL — optional, defaults to onboarding@resend.dev (works for testing
                           but you'll want to add a verified sender domain later)
"""
import os
import sys

import requests


def send(subject: str, html: str) -> None:
    api_key = os.environ.get("RESEND_API_KEY")
    to_addr = os.environ.get("MX_LISTINGS_TO_EMAIL")
    from_addr = os.environ.get("MX_LISTINGS_FROM_EMAIL", "onboarding@resend.dev")

    if not api_key or not to_addr:
        print("ERROR: RESEND_API_KEY and MX_LISTINGS_TO_EMAIL must be set", file=sys.stderr)
        sys.exit(1)

    r = requests.post(
        "https://api.resend.com/emails",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        json={
            "from": from_addr,
            "to": [to_addr],
            "subject": subject,
            "html": html,
        },
        timeout=30,
    )
    if r.status_code >= 300:
        print(f"ERROR: Resend returned {r.status_code}: {r.text}", file=sys.stderr)
        sys.exit(1)
    print(f"Sent: {r.json()}")
