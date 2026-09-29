// src/pages/api/lead.ts — Lane C. Nobody else edits this file.
//
// Contract (C1): accepts JSON or form-data. JSON requests ALWAYS get a JSON
// response with all five keys: { ok, leadUuid, eventId, duplicate, redirect }.
// Form-data redirects only after capture; stored-nowhere returns a visible 503.
//
// Order of operations (checklist §4): attempt D1 first, then alternate capture
// then CRM / CAPI / sheet. A CRM or sheet failure can never fail the lead.
// Every failure lands in a status column AND fires the alert webhook (C6).

import type { APIRoute } from 'astro';
import { validPhoneE164 } from '../../lib/phone';
import {
  readAttribution,
  parseAdParams,
  fullUrl,
  uuidv7,
} from '../../lib/attribution';
import {
  asString,
  buildUserData,
  capiSend,
  fireAlert,
  getBinding,
  getEnv,
  ghlBase,
  googleTokenUrl,
  normEmail,
  phone10,
  sheetsBase,
  type Dict,
} from '../../lib/server';

export const prerender = false;

const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHEET_TAB = 'HTL B2B Leads';

type D1Database = import('@cloudflare/workers-types').D1Database;

function bodyBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 'on' || v === '1' || v === 1;
}

function json(status: number, payload: Dict): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function contractError(status: number, error: string): Response {
  // Errors still carry the five contract keys so the client never branches on shape.
  return json(status, { ok: false, leadUuid: '', eventId: '', duplicate: false, redirect: '', error });
}

// ---------- Google Sheets (C7: projection, upserted by lead_uuid) ----------

async function getGoogleAccessToken(clientEmail: string, privateKeyPem: string): Promise<string | null> {
  const tokenUrl = googleTokenUrl();
  let assertion = '';
  try {
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
    const payload = { iss: clientEmail, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: tokenUrl, exp: now + 3600, iat: now };
    const msg = `${b64url(header)}.${b64url(payload)}`;
    const sig = await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, cryptoKey, new TextEncoder().encode(msg));
    const sigBytes = new Uint8Array(sig);
    const sigB64 = btoa(String.fromCharCode(...sigBytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    assertion = `${msg}.${sigB64}`;
  } catch (e) {
    // Local smoke test runs with a stub key that can't be JWT-signed; the stub
    // token endpoint ignores the assertion. In prod (default token URL) a bad
    // key is a real failure.
    if (googleTokenUrl().includes('googleapis.com')) {
      console.error('Google JWT build error:', (e as Error)?.name || 'unknown', (e as Error)?.message?.slice(0, 200) || '');
      return null;
    }
    assertion = 'stub-unsigned-jwt';
  }
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10000),
    });
    const data = (await res.json()) as Dict;
    if (!data?.access_token) console.error('Google token response:', res.status, JSON.stringify(data).slice(0, 300));
    return data?.access_token || null;
  } catch (e) {
    console.error('Google token error:', (e as Error)?.name || 'unknown', (e as Error)?.message?.slice(0, 200) || '');
    return null;
  }
}

/**
 * Upsert one row keyed by lead_uuid in column B (C7). D1 reserves a distinct
 * row before every first write, so concurrent requests never race on :append.
 */
async function upsertSheetRow(DB: D1Database | undefined, accessToken: string, sheetId: string, leadUuid: string, row: unknown[]): Promise<string> {
  if (!DB) return 'failed:no-d1-reservation';
  const base = sheetsBase();
  const encTab = encodeURIComponent(`'${SHEET_TAB}'`);
  try {
    const getRes = await fetch(`${base}/spreadsheets/${sheetId}/values/${encTab}!B:B`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!getRes.ok) {
      const t = await getRes.text();
      console.error('Sheet read FAILED:', getRes.status, t.slice(0, 300));
      return `failed:read:${getRes.status}`;
    }
    const existing = (await getRes.json()) as Dict;
    const vals = (existing?.values || []) as string[][];
    let existingRow = 0; // 1-based sheet row
    for (let i = 0; i < vals.length; i++) {
      if (vals[i]?.[0] === leadUuid) {
        existingRow = i + 1;
        break;
      }
    }
    let rowNumber = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (existingRow) {
        await DB.prepare(
          'INSERT OR IGNORE INTO sheet_row_reservations (sheet_id, lead_uuid, row_number) VALUES (?, ?, ?)'
        ).bind(sheetId, leadUuid, existingRow).run();
      } else {
        // INSERT...SELECT is one SQLite write statement. A unique row constraint
        // plus bounded retry handles a concurrent request seeing the same high-water.
        await DB.prepare(
          `INSERT OR IGNORE INTO sheet_row_reservations (sheet_id, lead_uuid, row_number)
           SELECT ?, ?, MAX(2, ?, COALESCE((SELECT MAX(row_number) + 1
             FROM sheet_row_reservations WHERE sheet_id = ?), 2))`
        ).bind(sheetId, leadUuid, vals.length + 1, sheetId).run();
      }
      const reserved = await DB.prepare(
        'SELECT row_number FROM sheet_row_reservations WHERE sheet_id = ? AND lead_uuid = ?'
      ).bind(sheetId, leadUuid).first<{ row_number: number }>();
      if (reserved?.row_number) { rowNumber = reserved.row_number; break; }
      if (existingRow) break; // its occupied row belongs to another reservation
    }
    if (!rowNumber || (existingRow && rowNumber !== existingRow)) return 'failed:reservation-conflict';
    const occupant = vals[rowNumber - 1]?.[0];
    if (occupant && occupant !== leadUuid) return 'failed:occupied-row';
    const range = `${encTab}!A${rowNumber}:AE${rowNumber}`;
    const putRes = await fetch(`${base}/spreadsheets/${sheetId}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      console.error('Sheet explicit row write FAILED:', putRes.status, t.slice(0, 300));
      return `failed:write:${putRes.status}`;
    }
    return existingRow ? 'ok:updated' : 'ok:written';
  } catch (e) {
    const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 200) || ''}`;
    console.error('Sheet upsert error:', msg);
    return `failed:${msg}`;
  }
}

// ---------- The endpoint ----------

export const POST: APIRoute = async ({ request, redirect, clientAddress }) => {
  const DB = getBinding<D1Database>('DB');
  const ghlApiKey = getEnv('GHL_API_KEY');
  const ghlLocationId = getEnv('GHL_LOCATION_ID');
  const metaPixelId = getEnv('META_PIXEL_ID');
  const metaCapiToken = getEnv('META_CAPI_TOKEN');
  const gSheetsId = getEnv('GOOGLE_SHEETS_ID');
  const gSheetsEmail = getEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const gSheetsKey = getEnv('GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY');

  const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
  let body: Dict;
  try {
    body = isJson
      ? ((await request.json()) as Dict)
      : Object.fromEntries(await request.formData());
  } catch {
    return contractError(400, 'Invalid request body.');
  }

  // ----- fields (accept both meaningful names (B9) and legacy names) -----
  const firstName = asString(body.first_name) || asString(body.name);
  const lastName = asString(body.last_name) || asString(body.lastName);
  const email = asString(body.email);
  const phoneRaw = asString(body.phone);

  if (firstName.length < 2 || !emailRe.test(email)) {
    return contractError(400, 'Name and valid email required.');
  }
  const phone = validPhoneE164(phoneRaw);
  if (!phone) return contractError(400, 'Enter a valid phone number.');

  const businessName = asString(body.businessName);
  const state = asString(body.state);
  const isOwner = asString(body.isOwner);
  const monthlyVolume = asString(body.monthlyVolume);
  const role = asString(body.role);

  let quizAnswers: string | null = null;
  if (typeof body.quizAnswers === 'string' && body.quizAnswers) quizAnswers = body.quizAnswers;
  else if (body.quizAnswers && typeof body.quizAnswers === 'object') quizAnswers = JSON.stringify(body.quizAnswers);

  // ----- attribution: the request cookie header is authoritative (A5/C9);
  //       body fields are the fallback for cookie-less submits -----
  const cookieHeader = request.headers.get('cookie') || '';
  const att = readAttribution(cookieHeader);

  let leadUuid = att.leadUuid;
  if (!leadUuid || !uuidRe.test(leadUuid)) {
    const fromBody = asString(body.leadUuid);
    leadUuid = fromBody && uuidRe.test(fromBody) ? fromBody : uuidv7();
  }

  // C2: the SERVER owns event identity, reusing it for retries. A browser-supplied
  // value is ignored — one authority, or dedup silently breaks.
  let eventId = uuidv7();

  const firstUrlBase = att.firstUrl || asString(body.firstUrl);
  const firstQuery = att.firstQuery || asString(body.firstQuery);
  const lastUrl = att.lastUrl || asString(body.lastUrl);
  const lastQuery = att.lastQuery || asString(body.lastQuery);
  const firstSeenAt = att.firstSeenAt || asString(body.firstSeenAt);
  const landingUrl = fullUrl(firstUrlBase, firstQuery) || asString(body.landingUrl) || 'https://hottublaunch.com';

  // A6: UTMs parsed with the explicit snake_case map. First touch answers
  // "which ad created this lead"; last touch fills gaps for untagged first visits.
  const utmFirst = parseAdParams(firstQuery);
  const utmLast = parseAdParams(lastQuery);
  const utm = (k: string) => utmFirst[k] || utmLast[k] || asString(body[k]);
  const utmSource = utm('utmSource');
  const utmMedium = utm('utmMedium');
  const utmCampaign = utm('utmCampaign');
  const utmContent = utm('utmContent');
  const utmTerm = utm('utmTerm');
  const gclid = utmFirst.gclid || utmLast.gclid || asString(body.gclid);
  const fbclid = utmFirst.fbclid || utmLast.fbclid || asString(body.fbclid);

  // fbp/fbc ride the Cookie header on every same-origin POST — read them
  // server-side, never trust the client body first.
  const cookieVal = (name: string) => {
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const fbp = cookieVal('_fbp') || asString(body.fbp);
  const fbc =
    cookieVal('_fbc') ||
    asString(body.fbc) ||
    (fbclid ? `fb.1.${Math.floor(Date.now() / 1000)}.${fbclid}` : '');

  // ----- consent (B8/C10): the exact rendered text, or it doesn't count -----
  const consentGiven = bodyBool(body.consentGiven) || bodyBool(body.terms);
  const consentText = asString(body.consentText);
  const consentVersion = asString(body.consentVersion);
  const consentUrl = asString(body.consentUrl);
  const now = new Date().toISOString();
  const consentAt = consentGiven ? now : '';
  // C11: contactable only with a real consent record — text included
  const contactable = consentGiven && consentText.length > 0 ? 1 : 0;

  const p10 = phone10(phone);
  const ip = request.headers.get('cf-connecting-ip') || clientAddress || '';
  const ua = request.headers.get('user-agent') || '';

  // ----- C3/C4: 24h duplicate suppression, successful conversions only -----
  let duplicate = false;
  let d1Status = 'skipped:no-binding';
  if (DB) {
    try {
      const dupRow = await DB.prepare(
        `SELECT lead_uuid, event_id FROM leads
         WHERE conversion_status = 'ok'
           AND datetime(COALESCE(updated_at, created_at)) > datetime('now', '-1 day')
           AND (lower(email) = ? OR (? <> '' AND substr(phone, -10) = ?))
         LIMIT 1`
      )
        .bind(normEmail(email), p10, p10)
        .first<{ lead_uuid: string; event_id: string }>();
      duplicate = !!dupRow;
      if (dupRow?.event_id) eventId = dupRow.event_id;
      else {
        const retry = await DB.prepare(
          `SELECT event_id FROM leads WHERE conversion_status IN ('failed', 'pending')
           AND datetime(COALESCE(updated_at, created_at)) > datetime('now', '-1 day')
           AND (lead_uuid = ? OR lower(email) = ? OR (? <> '' AND substr(phone, -10) = ?))
           ORDER BY datetime(COALESCE(updated_at, created_at)) DESC LIMIT 1`
        ).bind(leadUuid, normEmail(email), p10, p10).first<{ event_id: string }>();
        if (retry?.event_id) eventId = retry.event_id;
      }
    } catch (e) {
      const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 200) || ''}`;
      console.error('D1 dedup query error:', msg);
      await fireAlert({ alert: 'D1_DEDUP_QUERY_FAILED', lead_uuid: leadUuid, error: msg });
      // On dedup failure fail open (fire the conversion) — losing signal is
      // worse than a rare double-count, and the alert already told us.
    }
  }

  // ----- 1. D1 upsert — written FIRST, before any external call (C5:
  //       a duplicate is still a human; always store the record) -----
  let d1Ok = false;
  if (DB) {
    try {
      const stored = await DB.prepare(
        `INSERT INTO leads (
           lead_uuid, event_id, name, last_name, phone, email, fbp, fbc,
           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
           landing_url, quiz_answers, ip, user_agent, status, created_at,
           business_name, state, is_owner, monthly_volume, role,
           first_url, first_query, last_url, last_query, first_seen_at, gclid,
           consent_given, consent_text, consent_version, consent_url, consent_at,
           contactable, conversion_status, d1_status, updated_at, submit_count
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'ok',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending','ok',?,1)
         ON CONFLICT(lead_uuid) DO UPDATE SET
           event_id = COALESCE(NULLIF(leads.event_id, ''), excluded.event_id),
           name = excluded.name,
           last_name = COALESCE(NULLIF(excluded.last_name,''), leads.last_name),
           phone = COALESCE(NULLIF(excluded.phone,''), leads.phone),
           email = excluded.email,
           fbp = COALESCE(NULLIF(excluded.fbp,''), leads.fbp),
           fbc = COALESCE(NULLIF(excluded.fbc,''), leads.fbc),
           utm_source = COALESCE(NULLIF(excluded.utm_source,''), leads.utm_source),
           utm_medium = COALESCE(NULLIF(excluded.utm_medium,''), leads.utm_medium),
           utm_campaign = COALESCE(NULLIF(excluded.utm_campaign,''), leads.utm_campaign),
           utm_content = COALESCE(NULLIF(excluded.utm_content,''), leads.utm_content),
           utm_term = COALESCE(NULLIF(excluded.utm_term,''), leads.utm_term),
           landing_url = COALESCE(NULLIF(excluded.landing_url,''), leads.landing_url),
           quiz_answers = COALESCE(excluded.quiz_answers, leads.quiz_answers),
           ip = excluded.ip,
           user_agent = excluded.user_agent,
           business_name = COALESCE(NULLIF(excluded.business_name,''), leads.business_name),
           state = COALESCE(NULLIF(excluded.state,''), leads.state),
           is_owner = COALESCE(NULLIF(excluded.is_owner,''), leads.is_owner),
           monthly_volume = COALESCE(NULLIF(excluded.monthly_volume,''), leads.monthly_volume),
           role = COALESCE(NULLIF(excluded.role,''), leads.role),
           first_url = COALESCE(NULLIF(excluded.first_url,''), leads.first_url),
           first_query = COALESCE(NULLIF(excluded.first_query,''), leads.first_query),
           last_url = excluded.last_url,
           last_query = excluded.last_query,
           first_seen_at = COALESCE(NULLIF(excluded.first_seen_at,''), leads.first_seen_at),
           gclid = COALESCE(NULLIF(excluded.gclid,''), leads.gclid),
           consent_given = MAX(leads.consent_given, excluded.consent_given),
           consent_text = COALESCE(NULLIF(excluded.consent_text,''), leads.consent_text),
           consent_version = COALESCE(NULLIF(excluded.consent_version,''), leads.consent_version),
           consent_url = COALESCE(NULLIF(excluded.consent_url,''), leads.consent_url),
           consent_at = COALESCE(leads.consent_at, NULLIF(excluded.consent_at,'')),
           contactable = MAX(leads.contactable, excluded.contactable),
           d1_status = 'ok',
           status = 'ok',
           updated_at = excluded.updated_at,
           submit_count = leads.submit_count + 1
         RETURNING event_id`
      )
        .bind(
          leadUuid, eventId, firstName, lastName || null, phone || null, email, fbp, fbc,
          utmSource, utmMedium, utmCampaign, utmContent, utmTerm,
          landingUrl, quizAnswers, ip, ua, now,
          businessName || null, state || null, isOwner || null, monthlyVolume || null, role || null,
          firstUrlBase || null, firstQuery || null, lastUrl || null, lastQuery || null, firstSeenAt || null, gclid || null,
          consentGiven ? 1 : 0, consentText || null, consentVersion || null, consentUrl || null, consentAt || null,
          contactable, now
        )
        .first<{ event_id: string }>();
      if (!stored?.event_id) throw new Error('D1 returned no stored event ID');
      eventId = stored.event_id;
      d1Ok = true;
      d1Status = 'ok';
    } catch (e) {
      const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 300) || ''}`;
      d1Status = `failed:${msg}`;
      console.error('D1 upsert error:', msg);
      await fireAlert({ alert: 'D1_INSERT_FAILED', lead_uuid: leadUuid, email_domain: email.split('@')[1] || '', error: msg });
      // continue — GHL/sheet may still capture the human
    }
  } else {
    console.error('D1 binding missing — lead not stored in database');
    await fireAlert({ alert: 'D1_BINDING_MISSING', lead_uuid: leadUuid });
  }

  // ----- 2. GHL upsert (C6: log status + body; C10: consent custom field;
  //       C11: tag; suppression never skips this — C5) -----
  let ghlContactId = '';
  let ghlStatus = 'skipped:no-key';
  let ghlCaptured = false;
  if (ghlApiKey && ghlLocationId) {
    try {
      const customFields: Dict[] = [];
      const cfLeadUuid = getEnv('GHL_CF_LEAD_UUID_ID');
      if (cfLeadUuid) customFields.push({ id: cfLeadUuid, value: leadUuid });
      const cfConsent = getEnv('GHL_CF_CONSENT_TEXT_ID');
      if (cfConsent && consentGiven && consentText) {
        customFields.push({ id: cfConsent, value: `${consentText} | version=${consentVersion} | url=${consentUrl} | at=${consentAt}` });
      }
      const cfStoreOwner = getEnv('GHL_CF_STORE_OWNER_ID');
      if (cfStoreOwner && isOwner) customFields.push({ id: cfStoreOwner, value: isOwner });
      const cfUnits = getEnv('GHL_CF_UNITS_PER_MONTH_ID');
      if (cfUnits && monthlyVolume) customFields.push({ id: cfUnits, value: monthlyVolume });
      const tagSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      const tags = ['htl-b2b-website', contactable ? 'consent-captured' : 'no-consent-no-automation'];
      if (utmSource && tagSlug(utmSource)) tags.push(`source-${tagSlug(utmSource)}`);
      if (utmMedium && tagSlug(utmMedium)) tags.push(`medium-${tagSlug(utmMedium)}`);
      if (utmCampaign && tagSlug(utmCampaign)) tags.push(`campaign-${tagSlug(utmCampaign)}`);
      if (!utmSource && !fbclid && !gclid) tags.push('source-organic-or-direct');
      try {
        const path = new URL(lastUrl || request.headers.get('referer') || '').pathname;
        tags.push(`funnel-${tagSlug(path.replace(/^\/+|\/+$/g, '')) || 'home'}`);
      } catch { /* no trustworthy page context */ }
      const ghlPayload: Dict = {
        firstName,
        lastName: lastName || undefined,
        email,
        phone: phone || undefined,
        locationId: ghlLocationId,
        companyName: businessName || undefined,
        state: state || undefined,
        source: 'Hot Tub Launch B2B Website',
        // Tags are added only after verifying contact identity; upsert replaces them.
      };
      if (customFields.length) ghlPayload.customFields = customFields;

      const ghlRes = await fetch(`${ghlBase()}/contacts/upsert`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ghlApiKey}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(ghlPayload),
        signal: AbortSignal.timeout(10000),
      });
      const ghlText = await ghlRes.text();
      if (!ghlRes.ok) {
        // C6: status + FULL response body. `401 {"message":"Invalid JWT"}` must be visible.
        ghlStatus = `failed:${ghlRes.status}`;
        console.error('GHL upsert FAILED:', ghlRes.status, ghlText.slice(0, 500));
        await fireAlert({ alert: 'GHL_UPSERT_FAILED', lead_uuid: leadUuid, status: ghlRes.status, body: ghlText.slice(0, 500) });
      } else {
        let ghlData: Dict | null = null;
        try { ghlData = JSON.parse(ghlText) as Dict; } catch {}
        ghlContactId = (ghlData?.contact as Dict | undefined)?.id || '';
        if (ghlContactId) {
          const contactUrl = `${ghlBase()}/contacts/${encodeURIComponent(ghlContactId)}`;
          const headers = { Authorization: `Bearer ${ghlApiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
          let contact = ghlData?.contact as Dict;
          if (!asString(contact?.phone)) {
            const verifyRes = await fetch(contactUrl, { headers, signal: AbortSignal.timeout(10000) });
            if (!verifyRes.ok) throw new Error(`GHL contact verification failed:${verifyRes.status}`);
            contact = ((await verifyRes.json()) as Dict)?.contact;
          }
          if (validPhoneE164(asString(contact?.phone)) !== phone) {
            ghlStatus = 'failed:phone-mismatch';
            await fireAlert({ alert: 'GHL_PHONE_MISMATCH', lead_uuid: leadUuid, contact_id: ghlContactId });
          } else {
            ghlCaptured = true;
            try {
              const tagsRes = await fetch(`${contactUrl}/tags`, {
                method: 'POST', headers, body: JSON.stringify({ tags }), signal: AbortSignal.timeout(10000),
              });
              if (!tagsRes.ok) throw new Error(`HTTP ${tagsRes.status}`);
              ghlStatus = 'ok';
            } catch (e) {
              ghlStatus = 'failed:tag-sync';
              await fireAlert({ alert: 'GHL_TAG_SYNC_FAILED', lead_uuid: leadUuid, contact_id: ghlContactId,
                error: (e as Error)?.message?.slice(0, 200) || 'unknown' });
            }
          }
        } else {
          ghlStatus = 'failed:no-contact-id';
          console.error('GHL upsert: no contact.id in response. Status:', ghlRes.status, 'Body:', ghlText.slice(0, 500));
          await fireAlert({ alert: 'GHL_NO_CONTACT_ID', lead_uuid: leadUuid, status: ghlRes.status, body: ghlText.slice(0, 500) });
        }
      }
    } catch (e) {
      const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 300) || ''}`;
      ghlStatus = `failed:${msg}`;
      console.error('GHL upsert error:', msg);
      await fireAlert({ alert: 'GHL_UPSERT_ERROR', lead_uuid: leadUuid, error: msg });
    }
  } else {
    console.error('GHL secrets missing — no CRM record for this lead');
    await fireAlert({ alert: 'GHL_NOT_CONFIGURED', lead_uuid: leadUuid });
  }

  // ----- 3. Meta CAPI Lead event — suppressed for duplicates and ONLY for
  //       duplicates (C3/C5). event_source_url is the real first-touch
  //       landing URL with its params (C9). value + currency present (C12). -----
  let capiStatus = 'skipped:no-token';
  let conversionStatus = 'skipped';
  if (duplicate) {
    capiStatus = 'suppressed:duplicate-24h';
    conversionStatus = 'suppressed';
  } else if (metaCapiToken && metaPixelId) {
    const userData = await buildUserData({
      email,
      phone,
      firstName,
      lastName: lastName || undefined,
      state: state || undefined, // C8: st added because the form collects it; zp/ct NOT collected → N/A
      leadUuid,
      ip: ip || undefined,
      ua: ua || undefined,
      fbp: fbp || undefined,
      fbc: fbc || undefined,
    });
    const leadValue = parseFloat(getEnv('LEAD_VALUE_USD') || '0');
    const capiEvent: Dict = {
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: landingUrl,
      action_source: 'website',
      user_data: userData,
      custom_data: {
        funnel_type: 'hottublaunch_b2b',
        currency: getEnv('LEAD_CURRENCY') || 'USD',
        value: Number.isFinite(leadValue) ? leadValue : 0,
      },
    };
    const capiRes = await capiSend(metaPixelId, metaCapiToken, [capiEvent]);
    if (capiRes.ok) {
      capiStatus = `ok:${capiRes.status}`;
      conversionStatus = 'ok';
    } else {
      capiStatus = `failed:${capiRes.status}`;
      conversionStatus = 'failed'; // C4: a failed conversion allows a retry
      await fireAlert({ alert: 'CAPI_LEAD_FAILED', lead_uuid: leadUuid, status: capiRes.status, body: capiRes.body.slice(0, 500) });
    }
  } else {
    console.error('Meta CAPI secrets missing — no server event for this lead');
    await fireAlert({ alert: 'CAPI_NOT_CONFIGURED', lead_uuid: leadUuid });
  }

  // ----- 4. Google Sheet — a projection of the database, upserted by
  //       lead_uuid (C7). Duplicates still land here (C5). -----
  let sheetStatus = 'skipped:no-secrets';
  if (gSheetsId && gSheetsEmail && gSheetsKey) {
    const token = await getGoogleAccessToken(gSheetsEmail, gSheetsKey);
    if (token) {
      const row: unknown[] = [
        now, leadUuid, eventId, firstName, lastName || '', email, phone || '',
        businessName, asString(body.website), asString(body.city),
        state, asString(body.numLocations), asString(body.productsSold),
        asString(body.currentMarketing), asString(body.adSpend), asString(body.challenge),
        asString(body.requestedService), landingUrl, utmSource, utmMedium, utmCampaign,
        utmContent, utmTerm, fbclid, ghlContactId,
        firstQuery, consentGiven ? 'yes' : 'no', contactable ? 'yes' : 'no',
        conversionStatus, capiStatus, ghlStatus,
      ];
      sheetStatus = await upsertSheetRow(DB, token, gSheetsId, leadUuid, row);
      if (sheetStatus.startsWith('failed')) {
        await fireAlert({ alert: 'SHEET_UPSERT_FAILED', lead_uuid: leadUuid, detail: sheetStatus });
      }
    } else {
      sheetStatus = 'failed:no-token';
      await fireAlert({ alert: 'SHEET_TOKEN_FAILED', lead_uuid: leadUuid });
    }
  } else {
    console.error('Sheet secrets missing');
    await fireAlert({ alert: 'SHEET_NOT_CONFIGURED', lead_uuid: leadUuid });
  }

  // ----- 5. Final status write-back (C6: every outcome lands in a column) -----
  if (DB && d1Ok) {
    try {
      await DB.prepare(
        `UPDATE leads SET
           ghl_contact_id = COALESCE(NULLIF(?, ''), ghl_contact_id),
           ghl_status = ?,
           capi_status = ?,
           sheet_status = ?,
           conversion_status = CASE WHEN ? = 'suppressed' AND conversion_status = 'ok' THEN 'ok' ELSE ? END
         WHERE lead_uuid = ?`
      )
        .bind(ghlContactId, ghlStatus, capiStatus, sheetStatus, conversionStatus, conversionStatus, leadUuid)
        .run();
    } catch (e) {
      const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 200) || ''}`;
      console.error('D1 status write-back error:', msg);
      await fireAlert({ alert: 'D1_STATUS_WRITE_FAILED', lead_uuid: leadUuid, error: msg });
    }
  }

  // ----- 6. Respond (C1) -----
  const ok = d1Ok || ghlCaptured || sheetStatus.startsWith('ok');
  if (!ok) {
    await fireAlert({ alert: 'LEAD_STORED_NOWHERE', lead_uuid: leadUuid, d1: d1Status, ghl: ghlStatus, sheet: sheetStatus });
  }
  const payload = { ok, leadUuid, eventId, duplicate, redirect: '/confirmed' };
  if (isJson) return json(ok ? 200 : 500, payload);
  if (!ok) return new Response('We could not save your application. Please go back and try again.', {
    status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
  return redirect('/confirmed', 303);
};
