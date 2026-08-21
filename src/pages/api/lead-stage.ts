// src/pages/api/lead-stage.ts — Lane C (C13/C14). CRM stage push-back.
//
// Called from a GHL workflow on Opportunity Stage Changed:
//   POST /api/lead-stage
//   Authorization: Bearer <STAGE_WEBHOOK_SECRET>
//   { "leadUuid": "{{contact.lead_uuid}}", "event": "Schedule" }
//   closed-won adds the real money: { "event": "Purchase", "value": 8450 }
//
// Events + default values (agency value ladder; override with
// META_VALUE_QUALIFIED / META_VALUE_SCHEDULE / META_VALUE_SHOWED):
//   QualifiedLead 75 · Schedule 300 · Showed 600 · Purchase = real amount, required.
// Stage aliases accepted: qualified / appointment / showed / sold.
//
// Semantics:
//   - One stage event per lead, enforced by UNIQUE(lead_uuid, event_name) (C14).
//     A repeat call returns 200 {duplicate:true} and sends nothing.
//   - A FAILED send returns 502 and leaves the row unsent, so the next attempt
//     retries under the SAME event id (mirrors C4).
//   - Purchase without a positive value → 400. A made-up sale figure teaches
//     Meta to find more people like whoever it thinks paid it.

import type { APIRoute } from 'astro';
import { uuidv7, fullUrl, readAttribution } from '../../lib/attribution';
import {
  asString,
  buildUserData,
  capiSend,
  fireAlert,
  getBinding,
  getEnv,
  normEmail,
  phone10,
  type Dict,
} from '../../lib/server';

export const prerender = false;

type D1Database = import('@cloudflare/workers-types').D1Database;

const STAGE_ALIASES: Record<string, string> = {
  qualified: 'QualifiedLead',
  qualifiedlead: 'QualifiedLead',
  appointment: 'Schedule',
  schedule: 'Schedule',
  showed: 'Showed',
  sold: 'Purchase',
  purchase: 'Purchase',
};

function defaultValue(eventName: string): number {
  switch (eventName) {
    case 'QualifiedLead':
      return parseFloat(getEnv('META_VALUE_QUALIFIED') || '75');
    case 'Schedule':
      return parseFloat(getEnv('META_VALUE_SCHEDULE') || '300');
    case 'Showed':
      return parseFloat(getEnv('META_VALUE_SHOWED') || '600');
    default:
      return 0;
  }
}

function json(status: number, payload: Dict): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const DB = getBinding<D1Database>('DB');
  const secret = getEnv('STAGE_WEBHOOK_SECRET');
  const metaPixelId = getEnv('META_PIXEL_ID');
  const metaCapiToken = getEnv('META_CAPI_TOKEN');

  // Fail closed: an unconfigured secret must not mean an open endpoint.
  // Cookie-based requests (same-origin page scripts) are allowed without
  // the secret — the htl_lead_uuid cookie is the identity proof.
  if (!secret) {
    console.error('STAGE_WEBHOOK_SECRET not set — /api/lead-stage refuses all calls');
    return json(503, { ok: false, error: 'Stage endpoint not configured.' });
  }
  const auth = request.headers.get('authorization') || '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-stage-secret') || '';
  const cookieHeader = request.headers.get('cookie') || '';
  const att = readAttribution(cookieHeader);
  const fromCookie = !!att.leadUuid;
  // GHL workflows must supply the secret; same-origin page scripts are
  // authenticated by the htl_lead_uuid cookie the browser sends automatically.
  if (provided !== secret && !fromCookie) {
    return json(401, { ok: false, error: 'Unauthorized.' });
  }
  if (!DB) {
    await fireAlert({ alert: 'STAGE_D1_BINDING_MISSING' });
    return json(500, { ok: false, error: 'Database unavailable.' });
  }

  let body: Dict;
  try {
    body = (await request.json()) as Dict;
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body.' });
  }

  const rawEvent = asString(body.event) || asString(body.stage);
  const eventName = STAGE_ALIASES[rawEvent.toLowerCase()];
  if (!eventName) {
    return json(400, { ok: false, error: `Unknown event '${rawEvent}'. Use QualifiedLead | Schedule | Showed | Purchase (or qualified | appointment | showed | sold).` });
  }

  let value = typeof body.value === 'number' ? body.value : parseFloat(asString(body.value));
  if (!Number.isFinite(value) || value <= 0) {
    if (eventName === 'Purchase') {
      return json(400, { ok: false, error: 'Purchase requires a positive real value.' });
    }
    value = defaultValue(eventName);
  }
  const currency = asString(body.currency) || getEnv('LEAD_CURRENCY') || 'USD';

  // ----- resolve the lead: cookie → uuid → email → last-10 phone -----
  // Cookie (A5) is the primary path for same-origin page scripts — no body
  // params needed when the browser sends htl_lead_uuid automatically.
  const leadUuid = asString(body.leadUuid) || asString(body.lead_uuid) || att.leadUuid;
  const email = asString(body.email);
  const phone = asString(body.phone);
  let lead: Dict | null = null;
  try {
    if (leadUuid) {
      lead = (await DB.prepare('SELECT * FROM leads WHERE lead_uuid = ? LIMIT 1').bind(leadUuid).first()) as Dict | null;
    }
    if (!lead && email) {
      lead = (await DB.prepare('SELECT * FROM leads WHERE lower(email) = ? ORDER BY created_at DESC LIMIT 1').bind(normEmail(email)).first()) as Dict | null;
    }
    if (!lead && phone) {
      lead = (await DB.prepare('SELECT * FROM leads WHERE substr(phone, -10) = ? ORDER BY created_at DESC LIMIT 1').bind(phone10(phone)).first()) as Dict | null;
    }
  } catch (e) {
    const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 200) || ''}`;
    console.error('Stage lead lookup error:', msg);
    await fireAlert({ alert: 'STAGE_LOOKUP_FAILED', error: msg });
    return json(500, { ok: false, error: 'Lookup failed.' });
  }
  if (!lead) {
    return json(404, { ok: false, error: 'Lead not found. Send leadUuid, email, or phone.' });
  }
  const uuid = lead.lead_uuid as string;

  // ----- C14: one stage event per lead. Reuse the row (and its event id)
  //       when a prior send failed; no-op when it succeeded. -----
  let eventRow: Dict | null = null;
  try {
    eventRow = (await DB.prepare('SELECT * FROM lead_events WHERE lead_uuid = ? AND event_name = ? LIMIT 1').bind(uuid, eventName).first()) as Dict | null;
    if (eventRow && eventRow.capi_status === 'sent') {
      return json(200, { ok: true, duplicate: true, event: eventName, leadUuid: uuid, sent: false });
    }
    if (!eventRow) {
      await DB.prepare(
        `INSERT INTO lead_events (lead_uuid, event_name, event_id, value, currency, capi_status)
         VALUES (?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(lead_uuid, event_name) DO NOTHING`
      ).bind(uuid, eventName, uuidv7(), value, currency).run();
      eventRow = (await DB.prepare('SELECT * FROM lead_events WHERE lead_uuid = ? AND event_name = ? LIMIT 1').bind(uuid, eventName).first()) as Dict | null;
    }
  } catch (e) {
    const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 200) || ''}`;
    console.error('Stage event row error:', msg);
    await fireAlert({ alert: 'STAGE_EVENT_ROW_FAILED', lead_uuid: uuid, event: eventName, error: msg });
    return json(500, { ok: false, error: 'Event record failed.' });
  }
  if (!eventRow) {
    return json(500, { ok: false, error: 'Event record failed.' });
  }
  // Re-check after the race-safe insert: another call may have sent it already.
  if (eventRow.capi_status === 'sent') {
    return json(200, { ok: true, duplicate: true, event: eventName, leadUuid: uuid, sent: false });
  }

  if (!metaPixelId || !metaCapiToken) {
    await fireAlert({ alert: 'STAGE_CAPI_NOT_CONFIGURED', lead_uuid: uuid, event: eventName });
    return json(502, { ok: false, error: 'CAPI not configured; event stored unsent for retry.' });
  }

  // ----- fire CAPI with identity from the stored lead row -----
  const userData = await buildUserData({
    email: (lead.email as string) || '',
    phone: (lead.phone as string) || undefined,
    firstName: (lead.name as string) || undefined,
    lastName: (lead.last_name as string) || undefined,
    state: (lead.state as string) || undefined,
    leadUuid: uuid,
    fbp: (lead.fbp as string) || undefined,
    fbc: (lead.fbc as string) || undefined,
  });
  const capiEvent: Dict = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventRow.event_id, // a retry re-sends under the SAME id
    action_source: 'system_generated', // CRM stage change, not a website action
    user_data: userData,
    custom_data: {
      funnel_type: 'hottublaunch_b2b',
      currency,
      value,
    },
  };
  const src = fullUrl((lead.first_url as string) || '', (lead.first_query as string) || '') || (lead.landing_url as string) || '';
  if (src) capiEvent.event_source_url = src;

  const capiRes = await capiSend(metaPixelId, metaCapiToken, [capiEvent]);
  if (!capiRes.ok) {
    try {
      await DB.prepare('UPDATE lead_events SET capi_status = ?, value = ?, currency = ? WHERE lead_uuid = ? AND event_name = ?')
        .bind(`failed:${capiRes.status}`, value, currency, uuid, eventName).run();
    } catch {}
    await fireAlert({ alert: 'STAGE_CAPI_FAILED', lead_uuid: uuid, event: eventName, status: capiRes.status, body: capiRes.body.slice(0, 500) });
    // 502 so the GHL workflow retries; the row stays unsent under the same event id
    return json(502, { ok: false, error: 'CAPI send failed; will retry under the same event id.', event: eventName, leadUuid: uuid });
  }

  try {
    await DB.prepare(`UPDATE lead_events SET capi_status = 'sent', sent_at = ?, value = ?, currency = ? WHERE lead_uuid = ? AND event_name = ?`)
      .bind(new Date().toISOString(), value, currency, uuid, eventName).run();
  } catch (e) {
    console.error('Stage status update error:', (e as Error)?.name || 'unknown');
  }

  return json(200, {
    ok: true,
    duplicate: false,
    sent: true,
    event: eventName,
    leadUuid: uuid,
    value,
    currency,
    actionSource: 'system_generated',
  });
};
