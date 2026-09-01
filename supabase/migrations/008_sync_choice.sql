-- Phase 3.3: per-event Google Calendar choice from the review buttons.
-- Run in Supabase → SQL Editor. Idempotent.
--
-- family_events.sync_to_google:
--   true  = "Add to calendar"  — push to Google, even if the category is toggled off
--   false = "Save only"        — keep in the hub, never push to Google
--   null  = no explicit choice — follow the household's per-category sync toggles

alter table public.family_events
  add column if not exists sync_to_google boolean;

-- Don't even call the push function for "Save only" events
create or replace function public.trigger_push_calendar()
returns trigger language plpgsql security definer as $$
declare
  fn_url text;
  service_key text;
begin
  if new.status = 'approved' and (old.status is distinct from new.status)
     and new.google_event_id is null
     and new.sync_to_google is distinct from false then
    fn_url := current_setting('app.push_calendar_url', true);
    service_key := current_setting('app.service_role_key', true);
    if fn_url is null or service_key is null then
      return new;
    end if;
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body := jsonb_build_object('event_id', new.id::text)
    );
  end if;
  return new;
end $$;
