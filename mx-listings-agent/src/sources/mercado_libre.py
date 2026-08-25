"""
Mercado Libre Mexico real estate search.

Uses the public anonymous search endpoint — no API key required.
Docs: https://developers.mercadolibre.com.ar/en_us/items-y-busquedas

Category MLM1459 = Inmuebles (real estate). Children include houses/condos/land.
"""
import time
from typing import Iterable, Optional

import requests

from ..listing import Listing

BASE = "https://api.mercadolibre.com"
SITE = "MLM"  # Mexico
CATEGORY_REAL_ESTATE = "MLM1459"
PAGE_LIMIT = 50  # ML max per page
MAX_PAGES = 4    # cap at 200 results per search


def _attr(attrs: list, attr_id: str) -> Optional[str]:
    for a in attrs or []:
        if a.get("id") == attr_id:
            return a.get("value_name") or a.get("value_struct", {}).get("number")
    return None


def _int_attr(attrs: list, attr_id: str) -> Optional[int]:
    v = _attr(attrs, attr_id)
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _float_attr(attrs: list, attr_id: str) -> Optional[float]:
    v = _attr(attrs, attr_id)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def search(
    query: str,
    operation: str = "Venta",
    min_bedrooms: Optional[int] = None,
    min_price_mxn: Optional[float] = None,
    max_price_mxn: Optional[float] = None,
    state: Optional[str] = None,
) -> Iterable[Listing]:
    """
    Yield Listing objects matching the criteria. Pages through results up to MAX_PAGES.
    """
    offset = 0
    seen = 0

    for _ in range(MAX_PAGES):
        params = {
            "category": CATEGORY_REAL_ESTATE,
            "q": query,
            "limit": PAGE_LIMIT,
            "offset": offset,
            "OPERATION": operation,
        }
        if min_price_mxn is not None or max_price_mxn is not None:
            lo = int(min_price_mxn) if min_price_mxn else "*"
            hi = int(max_price_mxn) if max_price_mxn else "*"
            params["price"] = f"{lo}-{hi}"

        try:
            r = requests.get(f"{BASE}/sites/{SITE}/search", params=params, timeout=30)
            r.raise_for_status()
        except requests.RequestException as e:
            print(f"[mercado_libre] request failed: {e}")
            return

        data = r.json()
        results = data.get("results", [])
        if not results:
            return

        for item in results:
            listing = _parse(item)
            if listing is None:
                continue
            if min_bedrooms is not None and (listing.bedrooms or 0) < min_bedrooms:
                continue
            if state and listing.state and state.lower() not in listing.state.lower():
                continue
            yield listing
            seen += 1

        paging = data.get("paging", {})
        total = paging.get("total", 0)
        offset += PAGE_LIMIT
        if offset >= total:
            return
        time.sleep(0.5)  # be polite


def _parse(item: dict) -> Optional[Listing]:
    try:
        attrs = item.get("attributes", [])
        loc = item.get("location") or {}
        addr = item.get("address") or {}
        price = item.get("price")
        currency = item.get("currency_id") or "MXN"

        return Listing(
            source="mercado_libre",
            source_id=item.get("id"),
            title=item.get("title", ""),
            price_mxn=float(price) if currency == "MXN" and price else None,
            price_usd=float(price) if currency == "USD" and price else None,
            currency=currency,
            url=item.get("permalink", ""),
            city=(loc.get("city") or {}).get("name") or addr.get("city_name"),
            state=(loc.get("state") or {}).get("name") or addr.get("state_name"),
            neighborhood=(loc.get("neighborhood") or {}).get("name"),
            bedrooms=_int_attr(attrs, "BEDROOMS") or _int_attr(attrs, "ROOMS"),
            bathrooms=_float_attr(attrs, "FULL_BATHROOMS"),
            covered_area_m2=_float_attr(attrs, "COVERED_AREA"),
            total_area_m2=_float_attr(attrs, "TOTAL_AREA"),
            thumbnail=item.get("thumbnail"),
            raw=item,
        )
    except Exception as e:
        print(f"[mercado_libre] parse error: {e}")
        return None
