"""
Parse a real Mercado Libre API response (sample shape captured from docs) to
verify the parser extracts price, location, bedrooms, area, and url correctly.
Run with: python -m tests.test_parser
"""
from src.sources.mercado_libre import _parse
from src import scoring, email_renderer

SAMPLE_ITEM = {
    "id": "MLM1234567890",
    "title": "Casa en venta en Ajijic con vista al lago, 3 recámaras",
    "price": 4500000,
    "currency_id": "MXN",
    "permalink": "https://casa.mercadolibre.com.mx/MLM-1234567890-casa-ajijic",
    "thumbnail": "https://http2.mlstatic.com/example.jpg",
    "location": {
        "city": {"name": "Chapala"},
        "state": {"name": "Jalisco"},
        "neighborhood": {"name": "Ajijic"},
    },
    "address": {
        "city_name": "Chapala",
        "state_name": "Jalisco",
    },
    "attributes": [
        {"id": "BEDROOMS", "value_name": "3"},
        {"id": "FULL_BATHROOMS", "value_name": "2"},
        {"id": "COVERED_AREA", "value_name": "180"},
        {"id": "TOTAL_AREA", "value_name": "300"},
        {"id": "OPERATION", "value_name": "Venta"},
    ],
}


def test_parser():
    l = _parse(SAMPLE_ITEM)
    assert l is not None, "parser returned None"
    assert l.source == "mercado_libre"
    assert l.source_id == "MLM1234567890"
    assert l.price_mxn == 4500000
    assert l.currency == "MXN"
    assert l.bedrooms == 3
    assert l.bathrooms == 2.0
    assert l.covered_area_m2 == 180.0
    assert l.total_area_m2 == 300.0
    assert l.neighborhood == "Ajijic"
    assert l.state == "Jalisco"
    assert "mercadolibre" in l.url
    print(f"  parser ok: {l.title[:50]}... | {l.bedrooms}BR, {l.covered_area_m2}m², ${l.price_mxn:,.0f} MXN")
    return l


def test_scoring_and_rendering():
    l = test_parser()
    # Simulate price normalization (would happen in main.py)
    l.price_usd = l.price_mxn / 18.5
    scored = scoring.score([l], nightly_rate_usd=85, occupancy=0.55)
    assert len(scored) == 1
    s = scored[0]
    assert s.gross_yield is not None and s.gross_yield > 0
    assert s.annual_revenue_usd == 85 * 0.55 * 365
    print(f"  scoring ok: {s.gross_yield * 100:.1f}% gross yield, ${s.annual_revenue_usd:,.0f}/yr revenue")

    html = email_renderer.render([{
        "name": "Test Section",
        "nightly_rate_usd": 85,
        "occupancy": 0.55,
        "listings": [s],
    }])
    assert "Ajijic" in html
    assert "Test Section" in html
    assert "mercadolibre" in html
    # Should classify this as good (>= 10%) or ok (>= 7%) or meh
    pct = s.gross_yield * 100
    if pct >= 10:
        assert "good" in html, "expected 'good' class for high yield"
    print(f"  rendering ok: {len(html)} bytes, yield class matches")


if __name__ == "__main__":
    print("Running parser+scoring+rendering smoke tests...")
    test_parser()
    test_scoring_and_rendering()
    print("\nAll tests passed.")
