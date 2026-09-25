# Kids Hub: Color Chart

The daycare-style behavior chart, at home. Three circles stacked
green / yellow / red with ten spots on the ladder (10 is super green, 1 is
red). Her name slides up and down. Every morning she is back at 10
automatically.

Open it from Kids Hub → **🚦 Color Chart** (or `color-chart.html`). It
works on the big table in landscape and on a phone stacked.

## One-time setup
1. Supabase (Homestead project) → SQL Editor → run
   `supabase/migrations/026_color_chart.sql`, then
   `027_color_chart_ten_spots.sql` and `028_color_chart_naps.sql`.
2. In a terminal in the repo folder (after `git pull`):
   ```
   supabase functions deploy color-chart-share --no-verify-jwt
   ```
   The flag matters: the teacher has no login, the private link is the key.
3. Open the page once and enter her name and a 4-digit grown-up PIN.
   Starter chores and reasons are added for you.

## How it works
- **She taps a chore** ("Cleaned my room") with no PIN. It shows as
  waiting. A grown-up taps it, enters the PIN, and says Yes → she moves up
  with confetti. "Not yet" quietly drops it.
- **Move up / Move down** (grown-ups) ask for the PIN, then a chore or a
  reason plus an optional note. Everything is logged with the time.
- **Spots**: every up or down asks "how many spots?" (1 to 5). Each
  chore or reason has a usual number in ⚙ settings that is pre-picked.
  Moving up past the top does not bank against a later down.
- **✕ on a log line** (PIN) removes a mistake.
- **Past days** shows the last two weeks as little colored circles. Tap a
  day to see its log, remove a mistake, or add an up or down for that day
  with a time (PIN).

## Nap unicorns
Five unicorns a week, Monday to Friday. A nap at school lights one up;
no nap greys it out. Tap a day to mark it: the teacher from her link, or
a grown-up with the PIN. Fresh five every Monday, with last week's count
underneath.

## Teacher link
⚙ settings → **Copy link** and text it to the teacher. On her phone she
sees the ladder, today's log, and can add an up or down from daycare
(no PIN, she picks the spots, marked 🏫 Teacher at home) and mark naps. Switch off
"Teacher sees today's log" to show her only the color and counts.
**New link** makes the old one stop working.

## Keeping the table logged in
The table just needs a browser that stays signed in as you; open the page
and leave it. It refreshes itself every 10 seconds, so approving from your
phone shows up on the table.
