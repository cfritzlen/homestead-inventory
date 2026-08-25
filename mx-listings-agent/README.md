# MX Listings Agent

Weekly automated search for Mexican real estate listings, ranked by Airbnb-yield potential, emailed to you as an HTML digest with an interactive calculator embedded inline.

## What it does

Every Monday morning the GitHub Actions workflow runs `src/main.py`. For each saved search in `searches.yaml` it queries Mercado Libre's public API (no auth required), normalizes the results, computes a gross-yield estimate, ranks the top picks, and emails the digest via Resend.

## Configuration

### `searches.yaml`
The only file you edit week-to-week. One entry per search you want run:

```yaml
- name: Ajijic 2BR+
  city_query: ajijic
  state: Jalisco
  operation: Venta
  min_bedrooms: 2
  max_price_usd: 350000
  nightly_rate_usd: 80
  occupancy: 0.55
```

`nightly_rate_usd` and `occupancy` are the Airbnb assumptions for that area; they feed the yield calculation. You can also edit them later in the email's embedded calculator to see what-ifs.

### Repo secrets (Settings → Secrets and variables → Actions)
- `RESEND_API_KEY` — get one free at https://resend.com (no phone, 100 emails/mo on free tier)
- `MX_LISTINGS_TO_EMAIL` — your destination address
- `MX_LISTINGS_FROM_EMAIL` — your Resend sender (defaults to `onboarding@resend.dev` for testing)

## Running locally

```bash
cd mx-listings-agent
pip install -r requirements.txt
python -m src.main --dry-run    # writes email to ./out/digest.html instead of sending
python -m src.main               # actually sends
```

## Coverage caveat

Mercado Libre is strong in Mexican metro areas (CDMX, GDL, MTY, Mérida) but lighter in expat micro-markets (Ajijic, Tulum, Los Cabos). v2 may add an Inmuebles24 scraper if v1 coverage is thin — that would need a small scraping API budget.

## Cost

- GitHub Actions cron: free (well under the 2000 min/mo free quota)
- Mercado Libre API: free, no auth
- Resend: free up to 100 emails/mo
- Total: $0/week
