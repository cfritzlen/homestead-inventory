-- Color Chart: ten spots on the ladder, and "how many spots?" is asked on
-- every up or down, so weights may go higher. Run in Supabase → SQL Editor
-- after 026_color_chart.sql. Safe to re-run.

alter table public.color_chart_actions drop constraint if exists color_chart_actions_weight_check;
alter table public.color_chart_actions add constraint color_chart_actions_weight_check check (weight between 1 and 9);

alter table public.color_chart_events drop constraint if exists color_chart_events_weight_check;
alter table public.color_chart_events add constraint color_chart_events_weight_check check (weight between 1 and 9);
