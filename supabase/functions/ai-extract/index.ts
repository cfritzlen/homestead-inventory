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
      "title": "short human-readable title, e.g. 'Soccer practice', 'Dentist appointment', 'Daycare CLOSED — Labor Day'",
      "category": "school|daycare|medical|travel|vacation|sports|general",
      "starts_at": "ISO8601 datetime in America/New_York timezone, e.g. 2026-09-14T16:00:00-04:00",
      "ends_at": "ISO8601 datetime OR null if unknown",
      "all_day": true/false,
      "location": "string or null",
      "notes": "any extra detail from the doc worth remembering (bring-list, confirmation numbers, contact info)",
      "confidence": 0.0-1.0
    }
  ],
  "document_summary": "one sentence summarizing what this document is"
}

Rules:
- If a date is given without a year, assume the next occurrence from today.
- If a time is given without a date, DO NOT emit an event; put it in the summary instead.
- Multi-day items (vacations, tournaments): one event with all_day=true and both starts_at/ends_at set.
- ROUTINE MEALS ARE NOT EVENTS. Daycare/school menus listing breakfast, lunch, snack, or dinner
  for each day are informational — emit ZERO events for them, no matter how many dated meal
  entries appear. Summarize the menu in document_summary instead (e.g. "September menu for
  Bright Beginnings Daycare"). The same goes for recurring routine schedules like daily nap
  times or standing pickup times.
- What DOES count as an event on a menu or daycare/school calendar: closure days
  ("CLOSED — Labor Day"), holidays, early dismissals, field trips, picture days, parent
  meetings, deadlines — the exceptions, not the routine. Categorize daycare items as
  "daycare" and school-age school items as "school".
- Return {"events": [], "document_summary": "..."} if nothing extractable.
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
    const base64 = btoa(String.fromCharCode(...bytes));
    const mime = doc.mime_type || 'image/jpeg';

    // Only images work with vision; PDFs need doc-source or a rasterize step.
    // For v2 we handle images cleanly and log a note for PDFs.
    if (!mime.startsWith('image/') && mime !== 'application/pdf') {
      await logExtraction(docId, 'skipped: unsupported mime ' + mime);
      return json({ skipped: true, reason: 'unsupported mime ' + mime });
    }

    const content: any[] = [];
    if (mime.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: base64 },
      });
    } else {
      // PDF via document source (Claude supports application/pdf as a document)
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      });
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

    // Insert as proposed events
    let inserted = 0;
    for (const ev of events) {
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

    // Log the extraction (with cost estimate)
    const usage = claude.usage || {};
    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    // Haiku 4.5 rates as of 2026: $1/M input, $5/M output
    const cost = (inTok * 1 + outTok * 5) / 1_000_000;
    await logExtraction(docId, null, claude, inserted, inTok, outTok, cost);

    // Mark doc as processed
    await supa.from('family_documents').update({ extracted_at: new Date().toISOString() }).eq('id', docId);

    return json({ ok: true, events_created: inserted, cost_usd: cost });
  } catch (e) {
    return json({ error: `unhandled: ${e.message}` }, 500);
  }
});

async function logExtraction(
  docId: string, error: string | null, raw: any = null, eventsCreated = 0,
  inTok = 0, outTok = 0, cost = 0,
) {
  await supa.from('ai_extractions').insert({
    document_id: docId,
    model: ANTHROPIC_MODEL,
    prompt_tokens: inTok, output_tokens: outTok, cost_usd: cost,
    raw_response: raw, events_created: eventsCreated, error,
  });
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
