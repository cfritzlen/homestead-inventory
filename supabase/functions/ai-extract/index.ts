// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: ai-extract
//
// Trigger: DB trigger on family_documents INSERT (see 002_ai_and_calendar.sql).
// Payload:  { document_id: uuid }
//
// Downloads the document from Storage, sends it to Claude Haiku vision with
// a strict JSON-only extraction prompt, and inserts each extracted event as
// status='proposed' into family_events.
//
// Env / secrets (set with `supabase secrets set`):
//   SUPABASE_URL                 — auto-provided
//   SUPABASE_SERVICE_ROLE_KEY    — auto-provided
//   ANTHROPIC_API_KEY            — you set this
//   ANTHROPIC_MODEL              — optional, default claude-haiku-4-5-20251001

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const EXTRACTION_PROMPT = `You are extracting calendar events from a photo/scan of a school note, daycare notice, itinerary, doctor letter, sports schedule, or similar family document.

Return ONLY a JSON object with this exact shape (no prose, no code fences):

{
  "events": [
    {
      "title": "SHORT title, 5 words max, e.g. 'Soccer practice', 'Dentist appointment', 'Daycare closed'",
      "category": "school|daycare|medical|travel|vacation|sports|general",
      "starts_at": "ISO8601 datetime in America/New_York timezone, e.g. 2026-09-14T16:00:00-04:00",
      "ends_at": "ISO8601 datetime OR null if unknown",
      "all_day": true/false,
      "location": "string or null",
      "notes": "ONE short line (12 words max) of must-know detail only — bring-list, confirmation number, contact. null if nothing essential",
      "confidence": 0.0-1.0
    }
  ],
  "tasks": [
    {
      "title": "short action phrase, 6 words max, e.g. 'Sign permission slip', 'Pay October rent', 'RSVP class party'",
      "due_date": "YYYY-MM-DD or null if no deadline given",
      "notes": "ONE short line (12 words max): who/amount/where. null if the title says it all",
      "confidence": 0.0-1.0
    }
  ],
  "document_summary": "one sentence summarizing what this document is"
}

Rules:
- If a date is given without a year, assume the next occurrence from today.
- If a time is given without a date, DO NOT emit an event; put it in the summary instead.
- Multi-day items (vacations, tournaments): one event with all_day=true and both starts_at/ends_at set.
- RECURRING SERIES ("practice every Friday", "Tuesdays Sept 9 – Oct 28", weekly classes):
  emit ONE EVENT PER OCCURRENCE, all with the same title, from the first date through the
  stated end date (8 weeks max if no end is given). Put the pattern in each event's notes,
  e.g. "Fridays through Oct 24". Do NOT collapse a series into a single event.
- ROUTINE MEALS ARE NOT EVENTS. Daycare/school menus listing breakfast, lunch, snack, or dinner
  for each day are informational — emit ZERO events for them, no matter how many dated meal
  entries appear. Summarize the menu in document_summary instead (e.g. "September menu for
  Bright Beginnings Daycare"). The same goes for recurring routine schedules like daily nap
  times or standing pickup times.
- What DOES count as an event on a menu or daycare/school calendar: closure days
  ("CLOSED — Labor Day"), holidays, early dismissals, field trips, picture days, parent
  meetings, deadlines — the exceptions, not the routine. Categorize daycare items as
  "daycare" and school-age school items as "school".
- TASKS are things the family must DO: fill out or sign a form, make or send a payment,
  RSVP, bring or return something, schedule an appointment, submit or renew something.
  A plain calendar event is NOT also a task — only emit a task when there's an action
  beyond showing up. A request for money (rent due, invoice, school fees) IS a task.
- BE BRIEF. Titles and notes show on a phone screen: no full sentences, no restating the
  date/category in the title, never copy paragraphs from the document into notes.
- Return {"events": [], "tasks": [], "document_summary": "..."} if nothing extractable.
- confidence < 0.5 for anything you're guessing.`;

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const docId: string = body.document_id;
    if (!docId) return json({ error: 'missing document_id' }, 400);

    // Fetch document row
    const { data: doc, error: docErr } = await supa
      .from('family_documents').select('*').eq('id', docId).single();
    if (docErr || !doc) return json({ error: `doc not found: ${docErr?.message}` }, 404);

    // Download the file bytes
    const { data: blob, error: dlErr } = await supa.storage
      .from('family-docs').download(doc.storage_path);
    if (dlErr || !blob) return json({ error: `storage download failed: ${dlErr?.message}` }, 500);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Chunked encoding — spreading a large Uint8Array into fromCharCode blows
    // the call stack for files over ~100KB.
    let binary = '';
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
    }
    const base64 = btoa(binary);
    const mime = doc.mime_type || 'image/jpeg';

    const content: any[] = [];
    if (mime.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: base64 },
      });
    } else if (mime === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
    } else if (mime.startsWith('text/')) {
      // Gmail-ingested email bodies arrive as text/plain
      const text = new TextDecoder().decode(bytes);
      content.push({ type: 'text', text: `Document contents:\n\n${text.slice(0, 30000)}` });
    } else {
      await logExtraction(docId, 'skipped: unsupported mime ' + mime);
      return json({ skipped: true, reason: 'unsupported mime ' + mime });
    }
    content.push({ type: 'text', text: EXTRACTION_PROMPT });

    // Call Claude
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      await logExtraction(docId, `claude ${claudeRes.status}: ${errText}`, null, 0);
      return json({ error: `claude ${claudeRes.status}: ${errText}` }, 500);
    }
    const claude = await claudeRes.json();
    const text = claude.content?.[0]?.text || '';

    // Parse JSON — Claude sometimes wraps in ```json fences even when told not to
    let parsed: any;
    try {
      parsed = JSON.parse(text.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim());
    } catch (e) {
      await logExtraction(docId, `parse fail: ${e.message}`, claude, 0);
      return json({ error: 'model returned non-JSON', raw: text }, 500);
    }
    const events: any[] = parsed.events || [];

    // Insert as proposed events — skipping duplicates the household already
    // has (same title, same day, any status — covers the same email arriving
    // in two connected inboxes and re-scans).
    const likePattern = (s: string) => s.replace(/[%_]/g, '\\$&');
    let inserted = 0;
    for (const ev of events) {
      if (ev.title && ev.starts_at && !isNaN(Date.parse(ev.starts_at))) {
        const day = new Date(ev.starts_at); day.setUTCHours(0, 0, 0, 0);
        const nextDay = new Date(day.getTime() + 86400000);
        const { data: dupe } = await supa.from('family_events')
          .select('id')
          .eq('household_id', doc.household_id)
          .ilike('title', likePattern(ev.title))
          .gte('starts_at', day.toISOString())
          .lt('starts_at', nextDay.toISOString())
          .limit(1).maybeSingle();
        if (dupe) continue;
      }
      const row = {
        household_id: doc.household_id,
        category: ev.category || 'general',
        title: ev.title || '(no title)',
        starts_at: ev.starts_at,
        ends_at: ev.ends_at || null,
        all_day: !!ev.all_day,
        location: ev.location || null,
        notes: ev.notes || null,
        document_id: docId,
        status: 'proposed',
        source: 'ai',
        source_ref: docId,
        ai_confidence: ev.confidence ?? null,
        ai_notes: parsed.document_summary || null,
        created_by: doc.created_by,   // preserve original uploader
      };
      const { error: insErr } = await supa.from('family_events').insert(row);
      if (!insErr) inserted++;
    }

    // Insert extracted tasks as proposed to-dos
    const tasks: any[] = parsed.tasks || [];
    let tasksInserted = 0;
    for (const t of tasks) {
      if (!t.title) continue;
      // Skip a to-do that already exists (still open/proposed, or finished in
      // the last 30 days) with the same title, case-insensitive.
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data: taskDupe } = await supa.from('family_tasks')
        .select('id')
        .eq('household_id', doc.household_id)
        .ilike('title', likePattern(t.title))
        .or(`status.in.(proposed,open),completed_at.gte.${cutoff}`)
        .limit(1).maybeSingle();
      if (taskDupe) continue;
      const { error: taskErr } = await supa.from('family_tasks').insert({
        household_id: doc.household_id,
        title: t.title,
        notes: t.notes || null,
        due_date: t.due_date || null,
        status: 'proposed',
        source: 'ai',
        document_id: docId,
        ai_confidence: t.confidence ?? null,
        created_by: doc.created_by,
      });
      if (!taskErr) tasksInserted++;
    }

    // Log the extraction (with cost estimate + human-readable summary)
    const usage = claude.usage || {};
    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    // Haiku 4.5 rates as of 2026: $1/M input, $5/M output
    const cost = (inTok * 1 + outTok * 5) / 1_000_000;
    await logExtraction(docId, null, claude, inserted, inTok, outTok, cost, parsed.document_summary || null, tasksInserted);

    // Mark doc processed; auto-categorize it from the first event if untagged
    const docUpdate: any = { extracted_at: new Date().toISOString() };
    if (!doc.category && events.length) docUpdate.category = events[0].category || 'general';
    await supa.from('family_documents').update(docUpdate).eq('id', docId);

    return json({ ok: true, events_created: inserted, cost_usd: cost });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

async function logExtraction(
  docId: string, error: string | null, raw: any = null, eventsCreated = 0,
  inTok = 0, outTok = 0, cost = 0, summary: string | null = null, tasksCreated = 0,
) {
  await supa.from('ai_extractions').insert({
    document_id: docId,
    model: ANTHROPIC_MODEL,
    prompt_tokens: inTok, output_tokens: outTok, cost_usd: cost,
    raw_response: raw, events_created: eventsCreated, tasks_created: tasksCreated, error, summary,
  });
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
