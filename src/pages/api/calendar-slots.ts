// src/pages/api/calendar-slots.ts
// Proxies GHL free-slots API. Auth via htl_lead_uuid cookie (same-origin page scripts).
// No PIT key exposed to the browser.

import type { APIRoute } from 'astro';
import { readAttribution } from '../../lib/attribution';
import { getEnv, asString } from '../../lib/server';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const cookieHeader = request.headers.get('cookie') || '';
  const att = readAttribution(cookieHeader);
  if (!att.leadUuid) {
    return new Response(JSON.stringify({ ok: false, error: 'No lead session.' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const pitKey = getEnv('GHL_API_KEY');
  const calendarId = asString(getEnv('GHL_CALENDAR_ID')) || '2Cxr8gHsnc6xnMbeRPu9';
  if (!pitKey) {
    return new Response(JSON.stringify({ ok: false, error: 'Calendar not configured.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const tz = url.searchParams.get('timezone') || 'America/New_York';
  const days = parseInt(url.searchParams.get('days') || '7', 10);
  const now = new Date();
  const end = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/calendars/${calendarId}/free-slots?startDate=${Math.floor(now.getTime())}&endDate=${Math.floor(end.getTime())}&timezone=${encodeURIComponent(tz)}`,
      {
        headers: {
          Authorization: `Bearer ${pitKey}`,
          Version: '2021-07-28',
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    const data = await res.json();
    // Normalize GHL's {date: {slots: [...]}} → {date: [...]}
    const slots: Record<string, string[]> = {};
    for (const [date, val] of Object.entries(data as Record<string, any>)) {
      if (val && Array.isArray(val.slots)) slots[date] = val.slots;
    }
    return new Response(JSON.stringify({ ok: true, slots }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = (e as Error)?.message?.slice(0, 200) || 'unknown';
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};