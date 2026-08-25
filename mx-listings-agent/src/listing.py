from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Listing:
    source: str
    source_id: str
    title: str
    price_mxn: Optional[float]
    price_usd: Optional[float]
    currency: str
    url: str
    city: Optional[str] = None
    state: Optional[str] = None
    neighborhood: Optional[str] = None
    bedrooms: Optional[int] = None
    bathrooms: Optional[float] = None
    covered_area_m2: Optional[float] = None
    total_area_m2: Optional[float] = None
    thumbnail: Optional[str] = None
    raw: dict = field(default_factory=dict)

    # Filled in by scoring step
    nightly_rate_usd: Optional[float] = None
    occupancy: Optional[float] = None
    gross_yield: Optional[float] = None
    annual_revenue_usd: Optional[float] = None

    def dedupe_key(self) -> str:
        return f"{self.source}:{self.source_id}"
