name: SolArk Data Scraper

on:
  # Run every 4 hours
  schedule:
    - cron: '0 */4 * * *'

  # Manual runs
  workflow_dispatch:
    inputs:
      days_back:
        description: 'Number of days to backfill'
        required: false
        default: '3'

jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install requests

      - name: Run scraper
        env:
          SOLARK_USERNAME: ${{ secrets.SOLARK_USERNAME }}
          SOLARK_PASSWORD: ${{ secrets.SOLARK_PASSWORD }}
          SOLARK_PLANT_ID: ${{ secrets.SOLARK_PLANT_ID }}
          SOLARK_INVERTER_SN: ${{ secrets.SOLARK_INVERTER_SN }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: python scraper.py ${{ github.event.inputs.days_back || '3' }}
