// src/pages/api/calendar-book.ts
// Creates a GHL appointment and fires the Schedule CAPI event.
// Auth via htl_lead_uuid cookie. No PIT key exposed.
//
// Flow: resolve lead → create GHL appointment → fire Schedule (dedup-safe) → return

import type { APIRoute } from 'astro';
import { uuidv7, readAttribution } from '../../lib/attribution';
import {
  asString,
  buildUserData,
  capiSend,
  getBinding,
  getEnv,
  ghlBase,
  type Dict,
} from '../../lib/server';

export const prerender = false;

type D1Database = import('@cloudflare/workers-types').D1Database;

const SLOT_DURATION_MIN = 30; // HTL calendar: 30-min audit calls

export const POST: APIRoute = async ({ request }) => {
  const DB = getBinding<D1Database>('DB');
  const pitKey = getEnv('GHL_API_KEY');
  const locationId = getEnv('GHL_LOCATION_ID') || 'AG47jEV5rVUrGLt5FlKO';
  const calendarId = asString(getEnv('GHL_CALENDAR_ID')) || '2Cxr8gHsnc6xnMbeRPu9';
  const metaPixelId = getEnv('META_PIXEL_ID');
  const metaCapiToken = getEnv('META_CAPI_TOKEN');

  // ── Auth: cookie ──
  const cookieHeader = request.headers.get('cookie') || '';
  const att = readAttribution(cookieHeader);
  if (!att.leadUuid) {
    return new Response(JSON.stringify({ ok: false, error: 'No lead session.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Parse body ──
  let body: Dict;
  try { body = (await request.json()) as Dict; } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const slot = asString(body.slot); // ISO 8601, e.g. "2026-08-21T10:00:00-04:00"
  const name = asString(body.name) || '';
  const email = asString(body.email) || '';
  const phone = asString(body.phone) || '';

  if (!slot) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing slot.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Resolve lead ──
  let lead: Dict | null = null;
  try {
    lead = (await DB!.prepare('SELECT * FROM leads WHERE lead_uuid = ? LIMIT 1')
      .bind(att.leadUuid).first()) as Dict | null;
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'DB error.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (!lead) {
    return new Response(JSON.stringify({ ok: false, error: 'Lead not found.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const leadName = (lead.name as string) || name;
  const leadEmail = (lead.email as string) || email;
  const leadPhone = (lead.phone as string) || phone;

  // ── Compute end time ──
  const startTime = new Date(slot);
  if (isNaN(startTime.getTime())) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid slot format.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const endTime = new Date(startTime.getTime() + SLOT_DURATION_MIN * 60 * 1000);

  // ── Create GHL appointment ──
  let ghlAppointmentId = '';
  let ghlError = '';
  const ghlContactId = (lead.ghl_contact_id as string) || '';
  if (pitKey && ghlContactId) {
    try {
      const apptBody: Dict = {
        calendarId,
        locationId,
        contactId: ghlContactId,
        startTime: slot,
        endTime: endTime.toISOString(),
        title: `HTL Audit – ${leadName || 'New Lead'}`,
        meetingLocationType: 'custom',
        appointmentStatus: 'confirmed',
      };
      const apptRes = await fetch(`${ghlBase()}/calendars/events/appointments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${pitKey}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(apptBody),
      });
      const apptData = (await apptRes.json()) as Dict;
      if (apptRes.ok && apptData?.id) {
        ghlAppointmentId = apptData.id as string;
      } else {
        ghlError = `GHL ${apptRes.status}: ${JSON.stringify(apptData).slice(0, 200)}`;
      }
    } catch (e) {
      ghlError = (e as Error)?.message?.slice(0, 200) || 'unknown';
    }
  } else if (!ghlContactId) {
    ghlError = 'No GHL contact ID — lead upsert may have failed.';
  }

  // ── Fire Schedule event (dedup-safe, one per lead ever) ──
  let scheduleSent = false;
  let scheduleDuplicate = false;
  let eventId = '';
  let scheduleValue = 300;
  let scheduleCurrency = 'USD';

  try {
    // Check if Schedule already exists
    const existing = (await DB!.prepare(
      'SELECT * FROM lead_events WHERE lead_uuid = ? AND event_name = ? LIMIT 1',
    ).bind(att.leadUuid, 'Schedule').first()) as Dict | null;

    if (existing && existing.capi_status === 'sent') {
      scheduleDuplicate = true;
      eventId = existing.event_id as string;
    } else {
      eventId = existing?.event_id as string || uuidv7();

      if (!existing) {
        await DB!.prepare(
          `INSERT INTO lead_events (lead_uuid, event_name, event_id, value, currency, capi_status)
           VALUES (?, ?, ?, ?, ?, 'pending')
           ON CONFLICT(lead_uuid, event_name) DO NOTHING`,
        ).bind(att.leadUuid, 'Schedule', eventId, scheduleValue, scheduleCurrency).run();
      }

      // Fire CAPI
      if (metaPixelId && metaCapiToken) {
        const userData = await buildUserData({
          email: leadEmail,
          phone: leadPhone || undefined,
          firstName: leadName || undefined,
          lastName: (lead.last_name as string) || undefined,
          state: (lead.state as string) || undefined,
          leadUuid: att.leadUuid,
          fbp: (lead.fbp as string) || undefined,
          fbc: (lead.fbc as string) || undefined,
        });
        const capiEvent: Dict = {
          event_name: 'Schedule',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          action_source: 'website', // booking via the site
          user_data: userData,
          custom_data: {
            funnel_type: 'hottublaunch_b2b',
            currency: scheduleCurrency,
            value: scheduleValue,
          },
        };
        const src = ((lead.first_url as string) || '') + (((lead.first_query as string) || '') ? '?' + (lead.first_query as string) : '');
        if (src) capiEvent.event_source_url = src;

        const capiRes = await capiSend(metaPixelId, metaCapiToken, [capiEvent]);
        if (capiRes.ok) {
          scheduleSent = true;
          await DB!.prepare(
            `UPDATE lead_events SET capi_status = 'sent', sent_at = ?, value = ?, currency = ?
             WHERE lead_uuid = ? AND event_name = ?`,
          ).bind(new Date().toISOString(), scheduleValue, scheduleCurrency, att.leadUuid, 'Schedule').run();
        } else {
          await DB!.prepare(
            'UPDATE lead_events SET capi_status = ? WHERE lead_uuid = ? AND event_name = ?',
          ).bind(`failed:${capiRes.status}`, att.leadUuid, 'Schedule').run();
        }
      }
    }
  } catch (e) {
    // Schedule is best-effort; booking succeeds regardless
    console.error('Schedule event error:', (e as Error)?.message?.slice(0, 200));
  }

  // ── Return ──
  return new Response(JSON.stringify({
    ok: true,
    appointment: {
      slot,
      endTime: endTime.toISOString(),
      ghlAppointmentId: ghlAppointmentId || null,
      ghlError: ghlError || null,
    },
    schedule: {
      sent: scheduleSent,
      duplicate: scheduleDuplicate,
      eventId: eventId || null,
      value: scheduleValue,
      currency: scheduleCurrency,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};