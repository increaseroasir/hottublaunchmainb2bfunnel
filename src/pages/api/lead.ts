import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GHL_UPSERT_URL = 'https://services.leadconnectorhq.com/contacts/upsert';

type Dict = Record<string, any>;

function getScrt(key: string): string | undefined {
  // In Astro v6+ Cloudflare adapter, env comes from the module-level import
  try { return (env as Dict)?.[key] as string; } catch {}
  return (process.env as Dict)?.[key] as string | undefined;
}

function asString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

function uuidV7(): string {
  const now = Date.now();
  const ts = now.toString(16).padStart(12, '0');
  const rnd = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${rnd(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${rnd(3)}-${rnd(12)}`;
}

// Normalize email for hashing: lowercase + trim
function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Normalize phone: strip non-digits, keep country code if present
function normPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  // Strip international dialing prefix (00...)
  if (digits.startsWith('00')) digits = digits.slice(2);
  // US assumption: exactly 10 digits → prepend +1
  if (digits.length === 10) digits = '1' + digits;
  // 11+ digits: keep as-is (international numbers with their own country code untouched)
  return digits;
}

// E.164 format for GHL: +1XXXXXXXXXX
function phoneE164(phone: string): string {
  const digits = normPhone(phone);
  return digits ? '+' + digits : '';
}

// SHA-256 hex hash (WebCrypto — available in Cloudflare Workers)
async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Google Sheets: get access token via service-account JWT
async function getGoogleAccessToken(clientEmail: string, privateKeyPem: string): Promise<string | null> {
  try {
    // Handle both actual newlines and literal \n from JSON-escaped PEM
    const pem = privateKeyPem
      .replace(/-----BEGIN PRIVATE KEY-----/g, '')
      .replace(/-----END PRIVATE KEY-----/g, '')
      .replace(/\\n/g, '\n')
      .replace(/\s/g, '');
    const rawKey = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey('pkcs8', rawKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const now = Math.floor(Date.now() / 1000);
    const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iss: clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
    const msg = `${b64url(header)}.${b64url(payload)}`;
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, new TextEncoder().encode(msg));
    // Encode signature bytes to base64url (NOT JSON.stringify)
    const sigBytes = new Uint8Array(sig);
    const sigB64 = btoa(String.fromCharCode(...sigBytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const jwt = `${msg}.${sigB64}`;
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
    const data = await res.json() as Dict;
    if (!data?.access_token) console.error('Google token response:', JSON.stringify(data).slice(0, 200));
    return data?.access_token || null;
  } catch (e) {
    console.error('Google token error:', (e as Error)?.name || 'unknown');
    return null;
  }
}

// Google Sheets: append a row, dedup by event_id in column B
async function appendToSheet(accessToken: string, sheetId: string, tabName: string, row: unknown[], eventId: string): Promise<boolean> {
  try {
    // Wrap tab name in single quotes for names with spaces
    const encTab = encodeURIComponent(`'${tabName}'`);
    // Check existing rows for duplicate event_id
    const getRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encTab}!B:B`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (getRes.ok) {
      const existing = await getRes.json() as Dict;
      const vals = (existing?.values || []) as string[][];
      if (vals.some((r: string[]) => r[0] === eventId)) {
        return true; // already exists — skip
      }
    }
    // Append the row
    const appendRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encTab}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
    return appendRes.ok;
  } catch (e) {
    console.error('Sheet append error:', (e as Error)?.name || 'unknown');
    return false;
  }
}

export const POST: APIRoute = async ({ request, redirect, clientAddress }) => {
  const DB = getScrt('DB') as unknown as import('@cloudflare/workers-types').D1Database | undefined;
  const ghlApiKey = getScrt('GHL_API_KEY');
  const ghlLocationId = getScrt('GHL_LOCATION_ID');
  const metaPixelId = getScrt('META_PIXEL_ID');
  const metaCapiToken = getScrt('META_CAPI_TOKEN');
  const gSheetsId = getScrt('GOOGLE_SHEETS_ID');
  const gSheetsEmail = getScrt('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const gSheetsKey = getScrt('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');

  let body: Record<string, unknown>;

  try {
    const ct = request.headers.get('content-type') ?? '';
    body = ct.includes('application/json') ? await request.json() : Object.fromEntries(await request.formData());
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request body.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const name = asString(body.name);
  const lastName = asString(body.lastName);
  const email = asString(body.email);
  const phone = asString(body.phone);

  if (name.length < 2 || !emailRe.test(email)) {
    return new Response(JSON.stringify({ ok: false, error: 'Name and valid email required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  let leadUuid = asString(body.leadUuid);
  let eventId = asString(body.eventId);

  // Validate provided UUIDs; if missing, generate clean ones server-side
  if (leadUuid && !uuidRe.test(leadUuid)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid lead identifier.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (eventId && !uuidRe.test(eventId)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid event identifier.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  if (!leadUuid) leadUuid = uuidV7();
  if (!eventId) eventId = uuidV7();
  // fbp/fbc ride the Cookie header on every same-origin POST — read them server-side,
  // never trust the client body (the form posted empty strings even though cookies existed).
  const cookieHeader = request.headers.get('cookie') || '';
  const cookieVal = (name: string) => {
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const fbp = asString(body.fbp) || cookieVal('_fbp');
  const fbc = asString(body.fbc) || cookieVal('_fbc') || (asString(body.fbclid) ? `fb.1.${Math.floor(Date.now() / 1000)}.${asString(body.fbclid)}` : '');
  const utmSource = asString(body.utmSource);
  const utmMedium = asString(body.utmMedium);
  const utmCampaign = asString(body.utmCampaign);
  const utmContent = asString(body.utmContent);
  const utmTerm = asString(body.utmTerm);
  const landingUrl = asString(body.landingUrl) || `https://hottublaunch.com`;
  const quizAnswers = body.quizAnswers as Record<string, string> | undefined;

  const now = new Date().toISOString();
  // Real visitor IP — Cloudflare passes it in CF-Connecting-IP (not a proxy address)
  const ip = request.headers.get('cf-connecting-ip') || clientAddress || '';
  const ua = request.headers.get('user-agent') || '';

  // 1. Store in D1 (INSERT OR IGNORE so a retry with same lead_uuid doesn't fail)
  if (DB) {
    try {
      await DB.prepare(
        `INSERT OR IGNORE INTO leads (lead_uuid, event_id, name, last_name, phone, email, fbp, fbc, utm_source, utm_medium, utm_campaign, utm_content, utm_term, landing_url, quiz_answers, ip, user_agent, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`
      ).bind(leadUuid, eventId, name, lastName || null, phone || null, email, fbp, fbc, utmSource, utmMedium, utmCampaign, utmContent, utmTerm, landingUrl, quizAnswers ? JSON.stringify(quizAnswers) : null, ip, ua, now).run();
    } catch (e) {
      const errMsg = (e as Error)?.message || 'unknown';
      const errName = (e as Error)?.name || 'unknown';
      console.error('D1 insert error:', errName, errMsg);
      // Mark the lead as failed in D1 (INSERT may have failed entirely — try UPDATE if partial)
      try {
        await DB.prepare(
          `INSERT OR IGNORE INTO leads (lead_uuid, event_id, name, last_name, phone, email, status, status_message, created_at) VALUES (?, ?, ?, ?, ?, ?, 'd1_failed', ?, ?)`
        ).bind(leadUuid, eventId, name, lastName || null, email, `${errName}: ${errMsg.substring(0, 200)}`, now).run();
      } catch (e2) { /* best-effort */ }
      // Fire alert via webhook if configured
      const alertUrl = getScrt('ALERT_WEBHOOK_URL');
      if (alertUrl) {
        fetch(alertUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert: 'D1_INSERT_FAILED', lead_uuid: leadUuid, error: errName, message: errMsg.substring(0, 500) }),
        }).catch(() => {});
      }
    }
  }

  // 2. Upsert to GHL
  let ghlContactId = '';
  if (ghlApiKey && ghlLocationId) {
    try {
      const ghlPayload: Record<string, unknown> = {
        firstName: name,
        lastName: lastName || undefined,
        email,
        phone: phone ? phoneE164(phone) : undefined,
        locationId: ghlLocationId,
        source: 'Hot Tub Launch B2B Website',
      };

      const ghlRes = await fetch(GHL_UPSERT_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${ghlApiKey}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ghlPayload),
      });

      // Log the full GHL response for diagnostics — status + body (no token echo)
      if (!ghlRes.ok) {
        console.error('GHL upsert FAILED:', ghlRes.status, await ghlRes.text());
      }
      const ghlData = await ghlRes.json() as { contact?: { id?: string } } | null;
      ghlContactId = ghlData?.contact?.id || '';
      if (!ghlContactId) {
        console.error('GHL upsert: no contact.id in response. Status:', ghlRes.status, 'Body:', JSON.stringify(ghlData).slice(0, 500));
      }
      // Backfill D1 with the GHL contact ID so the lead↔contact link is never null
      if (ghlContactId && DB) {
        try {
          await DB.prepare(
            `UPDATE leads SET ghl_contact_id = ?, status = 'ghl_wired' WHERE lead_uuid = ?`
          ).bind(ghlContactId, leadUuid).run();
        } catch (e) {
          console.error('D1 ghl_contact_id backfill error:', (e as Error)?.name || 'unknown', (e as Error)?.message?.substring(0, 100) || '');
        }
      }
    } catch (e) {
      console.error('GHL upsert error:', (e as Error)?.name || 'unknown', (e as Error)?.message?.slice(0, 300) || 'no message');
    }
  }

  // 3. Send Meta CAPI Lead event
  if (metaCapiToken && metaPixelId) {
    try {
      const [hashEm, hashFn, hashLn, hashPh, hashExtId] = await Promise.all([
        sha256(normEmail(email)),
        sha256(name.toLowerCase().trim()),
        lastName ? sha256(lastName.toLowerCase().trim()) : Promise.resolve(''),
        phone ? sha256(normPhone(phone)) : Promise.resolve(''),
        sha256(leadUuid),
      ]);

      const capiEvent: Record<string, unknown> = {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: landingUrl,
        action_source: 'website',
        user_data: {
          em: [hashEm],
          fn: [hashFn],
          client_ip_address: ip || undefined,
          client_user_agent: ua || undefined,
          fbp: fbp || undefined,
          fbc: fbc || undefined,
          external_id: [hashExtId],
        },
        custom_data: {
          funnel_type: 'hottublaunch_b2b',
        },
      };

      if (hashLn) (capiEvent.user_data as Dict).ln = [hashLn];
      if (hashPh) (capiEvent.user_data as Dict).ph = [hashPh];

      const capiPayload: Dict = {
        data: [capiEvent],
      };

      const capiRes = await fetch(`https://graph.facebook.com/v21.0/${metaPixelId}/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${metaCapiToken}`,
        },
        body: JSON.stringify(capiPayload),
      });
      const capiBody = await capiRes.text() as string;
      // Log status + Meta response (contains no raw PII, no token echo)
      console.error('CAPI:', capiRes.status, capiBody);
    } catch (e) {
      // Never log the fetch URL or the error object — it may contain the token
      console.error('Meta CAPI error (suppressed to protect token):', (e as Error)?.name || 'unknown');
    }
  }

  // 4. Append to Google Sheet (HTL B2B Leads tab)
  let sheetOk = false;
  if (gSheetsId && gSheetsEmail && gSheetsKey) {
    const token = await getGoogleAccessToken(gSheetsEmail, gSheetsKey);
    if (token) {
      const row: unknown[] = [
        now, leadUuid, eventId, name, lastName || '', email, phone || '',
        asString(body.businessName), asString(body.website), asString(body.city),
        asString(body.state), asString(body.numLocations), asString(body.productsSold),
        asString(body.currentMarketing), asString(body.adSpend), asString(body.challenge),
        asString(body.requestedService), landingUrl, utmSource, utmMedium, utmCampaign,
        utmContent, utmTerm, asString(body.fbclid), ghlContactId,
      ];
      sheetOk = await appendToSheet(token, gSheetsId, 'HTL B2B Leads', row, eventId);
      if (!sheetOk) console.error('Sheet append failed (non-blocking)');
    } else {
      console.error('Sheet token unavailable');
    }
  } else {
    console.error('Sheet secrets missing');
  }

  // 5. Return — only eventId exposed (needed for Pixel dedup), never raw leadUuid or ghlContactId
  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
  if (isJson) {
    return new Response(JSON.stringify({ ok: true, eventId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return redirect('/confirmed', 303);
};