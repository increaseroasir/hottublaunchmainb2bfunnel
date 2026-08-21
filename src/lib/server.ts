// src/lib/server.ts
// Shared server-side helpers for /api/lead (Lane C) and /api/lead-stage.
// Normalization here MUST stay byte-identical to the client-side hashing in
// src/lib/lead-client.ts, or browser/server Advanced Matching identities split.

import { env as workerEnv } from 'cloudflare:workers';

export type Dict = Record<string, any>;

export function getEnv(key: string): string | undefined {
  // In Astro v6+ Cloudflare adapter, env comes from the module-level import
  try {
    const v = (workerEnv as Dict)?.[key];
    if (v !== undefined && v !== null) return v as string;
  } catch {}
  return (globalThis as Dict)?.process?.env?.[key] as string | undefined;
}

export function getBinding<T>(key: string): T | undefined {
  try {
    const v = (workerEnv as Dict)?.[key];
    if (v !== undefined && v !== null) return v as T;
  } catch {}
  return undefined;
}

// External service bases. Overridable ONLY so the local smoke test can point
// at a stub server; production uses the defaults. Never set these in prod.
export function ghlBase(): string {
  return getEnv('GHL_API_BASE') || 'https://services.leadconnectorhq.com';
}
export function capiBase(): string {
  return getEnv('META_CAPI_BASE') || 'https://graph.facebook.com/v21.0';
}
export function googleTokenUrl(): string {
  return getEnv('GOOGLE_TOKEN_URL') || 'https://oauth2.googleapis.com/token';
}
export function sheetsBase(): string {
  return getEnv('SHEETS_API_BASE') || 'https://sheets.googleapis.com/v4';
}

export function asString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

// Normalize email for hashing: lowercase + trim
export function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Normalize phone: strip non-digits, keep country code if present
export function normPhone(phone: string): string {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  // US assumption: exactly 10 digits → prepend 1
  if (digits.length === 10) digits = '1' + digits;
  return digits;
}

// E.164 format for GHL/D1 storage: +1XXXXXXXXXX
export function phoneE164(phone: string): string {
  const digits = normPhone(phone);
  return digits ? '+' + digits : '';
}

// Last 10 digits — the dedup key (C3), matches the substr(phone,-10) index
export function phone10(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-10);
}

// SHA-256 hex hash (WebCrypto — available in Cloudflare Workers)
export async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fire the alert webhook (Task 2 / D2). Never throws; a broken alert channel
 * must not break lead processing. But an UNCONFIGURED channel is itself
 * loudly logged — an unset ALERT_WEBHOOK_URL is why the GHL 401 ran for
 * months invisibly.
 */
export async function fireAlert(payload: Dict): Promise<void> {
  const alertUrl = getEnv('ALERT_WEBHOOK_URL');
  if (!alertUrl) {
    console.error('ALERT (webhook NOT CONFIGURED — set ALERT_WEBHOOK_URL):', JSON.stringify(payload).slice(0, 500));
    return;
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const secret = getEnv('ALERT_SECRET');
    if (secret) headers['X-Alert-Secret'] = secret;
    await fetch(alertUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ site: 'hottublaunch.com', at: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    console.error('Alert webhook send failed:', (e as Error)?.name || 'unknown', (e as Error)?.message?.slice(0, 200) || '');
  }
}

export type CapiResult = { ok: boolean; status: number; body: string };

/**
 * Send events to Meta CAPI. Logs status + full response body (C6) — the
 * response contains no raw PII and no token echo. Never logs the URL (token
 * is a header here, but keep the habit).
 */
export async function capiSend(pixelId: string, token: string, events: Dict[]): Promise<CapiResult> {
  try {
    // test_event_code goes at the top level of the CAPI payload, alongside
    // data. Driven by META_TEST_EVENT_CODE so it can be flipped on/off via a
    // secret without a redeploy. Remove/blank it before real traffic.
    const testEventCode = getEnv('META_TEST_EVENT_CODE')?.trim();
    const body: Dict = { data: events };
    if (testEventCode) body.test_event_code = testEventCode;

    const res = await fetch(`${capiBase()}/${pixelId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const respText = await res.text();
    console.error('CAPI:', res.status, respText.slice(0, 500));
    return { ok: res.ok, status: res.status, body: respText };
  } catch (e) {
    const msg = `${(e as Error)?.name || 'unknown'}: ${(e as Error)?.message?.slice(0, 300) || ''}`;
    console.error('CAPI network error:', msg);
    return { ok: false, status: 0, body: msg };
  }
}

/** Build hashed user_data for a lead row / submission. */
export async function buildUserData(input: {
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  state?: string;
  leadUuid?: string;
  ip?: string;
  ua?: string;
  fbp?: string;
  fbc?: string;
}): Promise<Dict> {
  const [em, fn, ln, ph, st, extId] = await Promise.all([
    input.email ? sha256(normEmail(input.email)) : Promise.resolve(''),
    input.firstName ? sha256(input.firstName.toLowerCase().trim()) : Promise.resolve(''),
    input.lastName ? sha256(input.lastName.toLowerCase().trim()) : Promise.resolve(''),
    input.phone ? sha256(normPhone(input.phone)) : Promise.resolve(''),
    input.state ? sha256(input.state.toLowerCase().trim()) : Promise.resolve(''),
    input.leadUuid ? sha256(input.leadUuid) : Promise.resolve(''),
  ]);
  const userData: Dict = {};
  if (em) userData.em = [em];
  if (fn) userData.fn = [fn];
  if (ln) userData.ln = [ln];
  if (ph) userData.ph = [ph];
  if (st) userData.st = [st];
  if (extId) userData.external_id = [extId];
  if (input.ip) userData.client_ip_address = input.ip;
  if (input.ua) userData.client_user_agent = input.ua;
  if (input.fbp) userData.fbp = input.fbp;
  if (input.fbc) userData.fbc = input.fbc;
  return userData;
}
