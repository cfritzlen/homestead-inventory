-- 1. Rejecting an event that was already pushed to Google Calendar now removes
--    it from Google too (push-to-calendar handles { action: 'delete' }).
-- 2. One-time sweep: approved events that repeat another approved event on the
--    same day get rejected (which, via 1, also clears the extra Google copies).
-- Safe to re-run.

create or replace function public.trigger_push_calendar()
returns trigger language plpgsql security definer as $$
declare
  fn_url text;
  service_key text;
begin
  fn_url := current_setting('app.push_calendar_url', true);
  service_key := current_setting('app.service_role_key', true);
  if fn_url is null or service_key is null then
    return new;
  end if;

  -- newly approved -> push
  if new.status = 'approved' and (old.status is distinct from new.status)
     and new.google_event_id is null
     and new.sync_to_google is distinct from false then
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body := jsonb_build_object('event_id', new.id::text)
    );
  end if;

  -- was on Google, now rejected -> remove from Google
  if new.status = 'rejected' and old.status = 'approved'
     and new.google_event_id is not null then
    perform net.http_post(
      url := fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || service_key
      ),
      body := jsonb_build_object('event_id', new.id::text, 'action', 'delete')
    );
  end if;
  return new;
end $$;

-- Sweep approved duplicates (same household, same day, same title ignoring
-- punctuation/case). Keeps the oldest copy; the rest are rejected.
with ranked as (
  select id,
         row_number() over (
           partition by household_id,
                        (starts_at at time zone 'America/New_York')::date,
                        regexp_replace(lower(coalesce(title, '')), '[^a-z0-9]+', ' ', 'g')
           order by created_at
         ) as rn
    from public.family_events
   where status = 'approved'
)
update public.family_events e
   set status = 'rejected'
  from ranked r
 where e.id = r.id and r.rn > 1;
