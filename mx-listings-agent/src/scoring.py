"""
Airbnb-yield scoring.

Gross yield = (nightly_rate × occupancy × 365) / purchase_price

This is a back-of-envelope heuristic, not a financial model. It ignores:
- HOA / maintenance / property tax / insurance
- Mortgage interest if financed
- Property-mgmt fees (~20-25% in MX)
- Repairs, vacancy beyond modeled occupancy, taxes on rental income
- Currency risk

Rule of thumb: a gross yield of ~10%+ in Mexico often translates to a net
yield of 5-7% after expenses. Adjust the calculator in the email to model
your own assumptions.
"""
from typing import Iterable, List

from .listing import Listing


def score(listings: Iterable[Listing], nightly_rate_usd: float, occupancy: float) -> List[Listing]:
    scored = []
    for l in listings:
        price = l.price_usd
        if price is None or price <= 0:
            continue
        annual_revenue = nightly_rate_usd * occupancy * 365
        l.nightly_rate_usd = nightly_rate_usd
        l.occupancy = occupancy
        l.annual_revenue_usd = annual_revenue
        l.gross_yield = annual_revenue / price
        scored.append(l)
    scored.sort(key=lambda x: x.gross_yield or 0, reverse=True)
    return scored
