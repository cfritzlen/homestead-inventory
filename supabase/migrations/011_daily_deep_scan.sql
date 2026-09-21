-- Daily auto-scan: once a day, every connected Google account gets the last
-- 36 hours of mail scanned for events (same as pressing "Scan inbox").
-- The overlapping window means a missed 15-minute poll can't lose anything.
--
-- Needs pg_cron + pg_net enabled and app.service_role_key set
-- (see docs/phase2-setup.md, steps 7 and 8). Safe to re-run.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'gmail-ingest-daily-deep-scan') then
    perform cron.unschedule('gmail-ingest-daily-deep-scan');
  end if;
end $$;

select cron.schedule(
  'gmail-ingest-daily-deep-scan',
  '0 10 * * *',   -- 10:00 UTC = 6 AM Eastern (5 AM in winter)
  $$
  select net.http_post(
    url := 'https://jzpipxvxrtdhmsdkveog.supabase.co/functions/v1/gmail-ingest',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('hours_back', 36)
  );
  $$
);
