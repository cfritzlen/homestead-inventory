"""
Entry point. Reads searches.yaml, runs each search, scores results, renders email,
and either sends it or writes it to ./out/digest.html (--dry-run).

Usage:
  python -m src.main           # send via Resend
  python -m src.main --dry-run # write to ./out/digest.html
"""
import argparse
import datetime as dt
import os
from pathlib import Path

import requests
import yaml

from . import email_renderer, scoring, send_email
from .sources import mercado_libre

REPO_ROOT = Path(__file__).resolve().parent.parent
SEARCHES_PATH = REPO_ROOT / "searches.yaml"
OUT_DIR = REPO_ROOT / "out"

USD_MXN_FALLBACK = 18.5  # used only if the live FX lookup fails


def get_usd_mxn_rate() -> float:
    """
    Fetch USD→MXN rate from a free, no-auth source. Falls back to a hardcoded
    value if the call fails so the weekly job never fails closed.
    """
    try:
        r = requests.get("https://open.er-api.com/v6/latest/USD", timeout=10)
        r.raise_for_status()
        rate = r.json()["rates"]["MXN"]
        print(f"USD→MXN rate: {rate}")
        return float(rate)
    except Exception as e:
        print(f"FX lookup failed ({e}), using fallback {USD_MXN_FALLBACK}")
        return USD_MXN_FALLBACK


def normalize_prices(listings, mxn_per_usd):
    """Fill in price_usd from price_mxn (or vice versa) using current FX rate."""
    for l in listings:
        if l.price_usd is None and l.price_mxn:
            l.price_usd = l.price_mxn / mxn_per_usd
        elif l.price_mxn is None and l.price_usd:
            l.price_mxn = l.price_usd * mxn_per_usd
    return listings


def load_searches():
    with open(SEARCHES_PATH) as f:
        return yaml.safe_load(f)


def run_search(search_cfg, mxn_per_usd):
    max_price_mxn = (search_cfg["max_price_usd"] * mxn_per_usd) if search_cfg.get("max_price_usd") else None
    min_price_mxn = (search_cfg["min_price_usd"] * mxn_per_usd) if search_cfg.get("min_price_usd") else None

    listings = list(mercado_libre.search(
        query=search_cfg["city_query"],
        operation=search_cfg.get("operation", "Venta"),
        min_bedrooms=search_cfg.get("min_bedrooms"),
        min_price_mxn=min_price_mxn,
        max_price_mxn=max_price_mxn,
        state=search_cfg.get("state"),
    ))
    listings = normalize_prices(listings, mxn_per_usd)
    listings = scoring.score(
        listings,
        nightly_rate_usd=search_cfg["nightly_rate_usd"],
        occupancy=search_cfg["occupancy"],
    )
    # Cap at top 10 per section to keep email scannable
    listings = listings[:10]
    return listings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Write to ./out/digest.html instead of sending")
    args = parser.parse_args()

    mxn_per_usd = get_usd_mxn_rate()
    searches = load_searches()
    sections = []
    for cfg in searches:
        print(f"\n=== {cfg['name']} ===")
        listings = run_search(cfg, mxn_per_usd)
        print(f"  {len(listings)} listings after scoring")
        sections.append({
            "name": cfg["name"],
            "nightly_rate_usd": cfg["nightly_rate_usd"],
            "occupancy": cfg["occupancy"],
            "listings": listings,
        })

    html = email_renderer.render(sections)
    subject = f"MX Listings — {dt.date.today().isoformat()}"

    if args.dry_run:
        OUT_DIR.mkdir(exist_ok=True)
        out_path = OUT_DIR / "digest.html"
        out_path.write_text(html)
        print(f"\nDry run — wrote {out_path} ({len(html)} bytes)")
    else:
        send_email.send(subject, html)


if __name__ == "__main__":
    main()
