// src/lib/attribution.ts
// Lane A — Attribution core. Mints lead_uuid on arrival, stores first/last touch
// in cookies at the request layer. Nobody parses UTMs in a page component again.
//
// Cookies:
//   htl_lead_uuid  — identity, write-once, 90d
//   htl_attr_first — first touch, write-once, 90d  {leadUuid, firstUrl, firstQuery, firstSeenAt, queryTruncated}
//   htl_attr_last  — last touch, overwritten,  90d  {lastUrl, lastQuery, queryTruncated}
//
// The last-touch cookie deliberately carries NO first-touch fields (bug 2 fix):
// duplicating both capped query strings in one cookie could exceed the 4KB
// browser limit after encodeURIComponent inflation, and the browser drops an
// oversized cookie silently.

export type Attribution = {
  leadUuid: string;
  firstUrl: string; // origin + pathname of first page view (query lives in firstQuery; see fullUrl())
  firstQuery: string; // raw query string, verbatim incl. leading '?' (capped, cut only at a '&' boundary)
  lastUrl: string;
  lastQuery: string; // raw query string, verbatim (capped)
  firstSeenAt: string; // ISO timestamp of first page view
  queryTruncated: boolean; // true if either query string exceeded the cap and was cut
};

type FirstTouchCookie = {
  leadUuid?: string;
  firstUrl?: string;
  firstQuery?: string;
  firstSeenAt?: string;
  queryTruncated?: boolean;
  // legacy fat-format fields tolerated on read, never written:
  lastUrl?: string;
  lastQuery?: string;
};

type LastTouchCookie = {
  lastUrl?: string;
  lastQuery?: string;
  queryTruncated?: boolean;
  // legacy fat-format fields tolerated on read, never written:
  leadUuid?: string;
  firstUrl?: string;
  firstQuery?: string;
  firstSeenAt?: string;
};

export const COOKIE_LEAD_UUID = 'htl_lead_uuid';
export const COOKIE_FIRST = 'htl_attr_first';
export const COOKIE_LAST = 'htl_attr_last';

/** Single source of truth for the browser pixel id. Layout.astro inlines the same value. */
export const META_PIXEL_ID = '1200252438858536';

const EXPIRE_DAYS = 90;
const EXPIRE_SEC = EXPIRE_DAYS * 24 * 60 * 60;
// Non-HttpOnly is deliberate: Lane B reads these client-side for the pixel.
const COOKIE_OPTS = `Secure; SameSite=Lax; Path=/; Max-Age=${EXPIRE_SEC}`;

/** Cap per stored query string, to stay inside cookie size limits. */
export const MAX_QUERY_LEN = 1024;

/**
 * Cap a raw query string without ever cutting mid-parameter (bug 3 fix).
 * Cuts at the last '&' before the cap; a single oversized param is trimmed
 * of any dangling percent-escape so the result always parses.
 */
export function capQuery(q: string): { value: string; truncated: boolean } {
  if (q.length <= MAX_QUERY_LEN) return { value: q, truncated: false };
  const slice = q.slice(0, MAX_QUERY_LEN);
  const cut = slice.lastIndexOf('&');
  if (cut > 0) return { value: slice.slice(0, cut), truncated: true };
  // one giant param and no separator: strip a dangling '%' or '%X' escape
  return { value: slice.replace(/%[0-9a-fA-F]?$/, ''), truncated: true };
}

/**
 * Real UUID v7 (bug 5 fix): 48-bit unix-ms timestamp + version/variant bits +
 * random tail. Time-ordered, so D1 rows sort by id creation time.
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const ts = Date.now();
  bytes[0] = Math.floor(ts / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ts / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ts / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ts / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Explicit URL-param → internal-field map (work order A6).
 * URL params are snake_case; internal fields are camelCase.
 * Never call params.get() with a camelCase name.
 */
export const AD_PARAM_MAP: Record<string, string> = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  utm_term: 'utmTerm',
  fbclid: 'fbclid',
  gclid: 'gclid',
  msclkid: 'msclkid',
  ttclid: 'ttclid',
};

/** Parse the mapped ad params out of a raw query string ('?a=b' or 'a=b'). */
export function parseAdParams(query: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!query) return out;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  } catch {
    return out;
  }
  for (const [raw, internal] of Object.entries(AD_PARAM_MAP)) {
    const v = params.get(raw);
    if (v) out[internal] = v;
  }
  return out;
}

/** Reconstruct a full URL from stored base + raw query (bug 4: firstUrl alone has no query). */
export function fullUrl(base: string, query: string): string {
  if (!base) return '';
  if (!query) return base;
  return query.startsWith('?') ? base + query : base + '?' + query;
}

function encode(val: unknown): string {
  return encodeURIComponent(JSON.stringify(val));
}

function decode<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw)) as T;
  } catch {
    return null;
  }
}

function getCookie(cookies: string, name: string): string | null {
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

function merge(
  leadUuid: string,
  first: FirstTouchCookie | null,
  last: LastTouchCookie | null
): Attribution {
  return {
    leadUuid,
    // legacy fat last-touch cookies may hold first-touch data the first cookie lost
    firstUrl: first?.firstUrl || last?.firstUrl || '',
    firstQuery: first?.firstQuery || last?.firstQuery || '',
    lastUrl: last?.lastUrl || '',
    lastQuery: last?.lastQuery || '',
    firstSeenAt: first?.firstSeenAt || last?.firstSeenAt || '',
    queryTruncated: !!(first?.queryTruncated || last?.queryTruncated),
  };
}

/**
 * Read attribution state from a request Cookie header.
 * Used by /api/lead (Lane C) on the server side.
 *
 * Bug 1 fix: when the identity cookie is absent, leadUuid is '' — a missing
 * identity is a fact the caller needs, not a gap to paper over. The caller
 * decides whether to mint. This function NEVER invents an identity.
 */
export function readAttribution(cookieHeader: string): Attribution {
  const first = decode<FirstTouchCookie>(getCookie(cookieHeader, COOKIE_FIRST));
  const last = decode<LastTouchCookie>(getCookie(cookieHeader, COOKIE_LAST));
  const leadUuid = getCookie(cookieHeader, COOKIE_LEAD_UUID) || '';
  return merge(leadUuid, first, last);
}

/**
 * Middleware handler. Called on every HTML request.
 * Sets cookies: htl_lead_uuid (write-once), htl_attr_first (write-once), htl_attr_last (overwrite).
 * Returns the Set-Cookie headers to add to the response plus the merged attribution
 * for the current request (exposed to pages via Astro.locals).
 */
export function handleAttribution(url: URL, cookies: string): {
  setCookies: string[];
  attribution: Attribution;
} {
  const setCookies: string[] = [];
  const now = new Date().toISOString();
  const capped = capQuery(url.search);
  const pageUrl = url.origin + url.pathname;

  // 1. lead_uuid — write once (mint on arrival is the design; readAttribution never mints)
  let leadUuid = getCookie(cookies, COOKIE_LEAD_UUID);
  if (!leadUuid) {
    leadUuid = uuidv7();
    setCookies.push(`${COOKIE_LEAD_UUID}=${leadUuid}; ${COOKIE_OPTS}`);
  }

  // 2. first-touch — write once, never overwrite
  let first = decode<FirstTouchCookie>(getCookie(cookies, COOKIE_FIRST));
  if (!first || !first.firstUrl) {
    first = {
      leadUuid,
      firstUrl: pageUrl,
      firstQuery: capped.value,
      firstSeenAt: now,
      queryTruncated: capped.truncated,
    };
    setCookies.push(`${COOKIE_FIRST}=${encode(first)}; ${COOKIE_OPTS}`);
  }

  // 3. last-touch — always overwrite; carries ONLY last-touch fields (bug 2 fix)
  const last: LastTouchCookie = {
    lastUrl: pageUrl,
    lastQuery: capped.value,
    queryTruncated: capped.truncated,
  };
  setCookies.push(`${COOKIE_LAST}=${encode(last)}; ${COOKIE_OPTS}`);

  return { setCookies, attribution: merge(leadUuid, first, last) };
}

/**
 * Client-side: read attribution cookies and return the values for hidden fields.
 * Used by Lane B's shared client script.
 */
export function readAttributionClient(): Attribution & {
  fbp: string;
  fbc: string;
  fbclid: string;
} {
  const cookies = document.cookie;
  const first = decode<FirstTouchCookie>(getCookie(cookies, COOKIE_FIRST));
  const last = decode<LastTouchCookie>(getCookie(cookies, COOKIE_LAST));
  const leadUuid = getCookie(cookies, COOKIE_LEAD_UUID) || '';
  const att = merge(leadUuid, first, last);

  // fbp/fbc from Meta cookies
  let fbp = '';
  let fbc = '';
  for (const c of cookies.split('; ')) {
    if (c.startsWith('_fbp=')) fbp = c.slice(5);
    if (c.startsWith('_fbc=')) fbc = c.slice(5);
  }

  // fbclid: first-touch query wins (the click that created the session), else last
  const fromQueries = parseAdParams(att.firstQuery);
  const fromLast = parseAdParams(att.lastQuery);
  const fbclid = fromQueries.fbclid || fromLast.fbclid || '';

  // Fallback: synthesize fbc from fbclid if the pixel hasn't set the cookie
  if (!fbc && fbclid) {
    fbc = `fb.1.${Math.floor(Date.now() / 1000)}.${fbclid}`;
  }

  return { ...att, fbp, fbc, fbclid };
}
