"""
Render the weekly HTML digest email.

One section per search. Embeds an interactive JS calculator at the top
so you can override the nightly-rate / occupancy / down-payment / interest
assumptions and immediately see the cash-flow impact, without leaving the email.
"""
from datetime import datetime
from typing import Dict, List

from jinja2 import Template

from .listing import Listing


TEMPLATE = Template("""<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>MX Listings Digest — {{ today }}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; max-width: 760px; margin: 0 auto; padding: 16px; color: #222; }
  h1 { font-size: 22px; margin: 8px 0 4px; }
  h2 { font-size: 18px; margin-top: 32px; padding-bottom: 4px; border-bottom: 1px solid #ddd; }
  .meta { color: #666; font-size: 13px; margin-bottom: 16px; }
  .calc { background: #f7f7f4; border: 1px solid #e3e3dd; border-radius: 8px; padding: 14px; margin: 12px 0 24px; }
  .calc h3 { margin: 0 0 8px; font-size: 15px; }
  .calc label { display: inline-block; width: 180px; font-size: 13px; }
  .calc input { width: 100px; padding: 3px 6px; font-size: 13px; }
  .calc .result { margin-top: 10px; font-size: 14px; }
  .calc .result b { color: #1d6b1d; }
  .card { border: 1px solid #e3e3dd; border-radius: 8px; padding: 12px; margin: 10px 0; display: flex; gap: 12px; }
  .card img { width: 140px; height: 100px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
  .card .body { flex: 1; }
  .card .title { font-weight: 600; font-size: 15px; margin-bottom: 4px; }
  .card .title a { color: #06408d; text-decoration: none; }
  .card .price { font-size: 16px; color: #111; }
  .card .specs { color: #555; font-size: 13px; margin: 4px 0; }
  .card .yield { font-size: 13px; }
  .yield .good { color: #1d6b1d; font-weight: 600; }
  .yield .ok { color: #ad7400; }
  .yield .meh { color: #888; }
  .empty { color: #888; font-style: italic; padding: 12px 0; }
  footer { color: #888; font-size: 12px; margin-top: 40px; border-top: 1px solid #eee; padding-top: 16px; }
</style>
</head><body>

<h1>Mexico listings — week of {{ today }}</h1>
<div class="meta">{{ total_count }} listings across {{ section_count }} searches · sorted by Airbnb gross-yield estimate within each section</div>

<div class="calc">
  <h3>Recalculate yield with your own assumptions</h3>
  <div><label>Purchase price (USD):</label><input id="px" type="number" value="300000"></div>
  <div><label>Nightly rate (USD):</label><input id="nr" type="number" value="100"></div>
  <div><label>Occupancy (0–1):</label><input id="oc" type="number" step="0.05" value="0.55"></div>
  <div><label>Annual expenses % of revenue:</label><input id="ex" type="number" step="5" value="35"></div>
  <div><label>Mortgage rate %:</label><input id="mr" type="number" step="0.25" value="0"></div>
  <div><label>Down payment %:</label><input id="dp" type="number" step="5" value="100"></div>
  <div class="result" id="out"></div>
</div>
<script>
function recalc() {
  var px = +document.getElementById('px').value;
  var nr = +document.getElementById('nr').value;
  var oc = +document.getElementById('oc').value;
  var ex = +document.getElementById('ex').value / 100;
  var mr = +document.getElementById('mr').value / 100;
  var dp = +document.getElementById('dp').value / 100;
  var rev = nr * oc * 365;
  var grossYield = px > 0 ? rev / px : 0;
  var netRev = rev * (1 - ex);
  var loan = px * (1 - dp);
  var annualInterest = loan * mr;
  var netCashflow = netRev - annualInterest;
  document.getElementById('out').innerHTML =
    'Gross revenue: <b>$' + Math.round(rev).toLocaleString() + '/yr</b> · ' +
    'Gross yield: <b>' + (grossYield * 100).toFixed(1) + '%</b><br>' +
    'After ' + Math.round(ex*100) + '% expenses & interest: <b>$' + Math.round(netCashflow).toLocaleString() + '/yr net</b>' +
    (px > 0 ? ' · <b>' + ((netCashflow / (px * dp)) * 100).toFixed(1) + '%</b> cash-on-cash' : '');
}
['px','nr','oc','ex','mr','dp'].forEach(function(id) {
  document.getElementById(id).addEventListener('input', recalc);
});
recalc();
</script>

{% for section in sections %}
<h2>{{ section.name }}</h2>
<div class="meta">
  {{ section.listings|length }} hits ·
  Assumed Airbnb: ${{ section.nightly_rate_usd }}/night × {{ (section.occupancy * 100)|round|int }}% occupancy ·
  Implied: ${{ (section.nightly_rate_usd * section.occupancy * 365)|round|int }}/yr gross revenue
</div>
{% if section.listings %}
  {% for l in section.listings %}
  <div class="card">
    {% if l.thumbnail %}<img src="{{ l.thumbnail }}" alt="">{% endif %}
    <div class="body">
      <div class="title"><a href="{{ l.url }}">{{ l.title }}</a></div>
      <div class="price">
        {% if l.price_usd %}${{ '{:,.0f}'.format(l.price_usd) }} USD{% endif %}
        {% if l.price_mxn %}{% if l.price_usd %} · {% endif %}${{ '{:,.0f}'.format(l.price_mxn) }} MXN{% endif %}
      </div>
      <div class="specs">
        {% if l.bedrooms %}{{ l.bedrooms }} BR · {% endif %}
        {% if l.bathrooms %}{{ l.bathrooms }} BA · {% endif %}
        {% if l.covered_area_m2 %}{{ l.covered_area_m2|round|int }} m² covered · {% endif %}
        {% if l.neighborhood %}{{ l.neighborhood }}, {% endif %}{{ l.city or '' }}{% if l.state %}, {{ l.state }}{% endif %}
      </div>
      <div class="yield">
        Gross yield:
        {% if l.gross_yield is not none %}
          {% set pct = l.gross_yield * 100 %}
          {% if pct >= 10 %}<span class="good">{{ '%.1f'|format(pct) }}%</span> ✓ pays for itself
          {% elif pct >= 7 %}<span class="ok">{{ '%.1f'|format(pct) }}%</span> close
          {% else %}<span class="meh">{{ '%.1f'|format(pct) }}%</span>
          {% endif %}
        {% else %} — {% endif %}
        · ${{ '{:,.0f}'.format(l.annual_revenue_usd or 0) }}/yr est. revenue
      </div>
    </div>
  </div>
  {% endfor %}
{% else %}
  <div class="empty">No matching listings this week.</div>
{% endif %}
{% endfor %}

<footer>
Generated {{ today }} · Source: Mercado Libre Mexico (public API) ·
<a href="https://github.com/cfritzlen/homestead-inventory/tree/main/mx-listings-agent">edit searches.yaml</a> to tune
</footer>
</body></html>
""")


def render(sections: List[Dict]) -> str:
    today = datetime.utcnow().strftime("%Y-%m-%d")
    total = sum(len(s["listings"]) for s in sections)
    return TEMPLATE.render(
        today=today,
        sections=sections,
        total_count=total,
        section_count=len(sections),
    )
