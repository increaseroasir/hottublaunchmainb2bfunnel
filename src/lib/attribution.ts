// src/lib/attribution.ts
// Lane A — Attribution core. Mints lead_uuid on arrival, stores first/last touch
// in cookies at the request layer. Nobody parses UTMs in a page component again.

export type Attribution = {
  leadUuid: string;
  firstUrl: string;
  firstQuery: string;        // raw query string, verbatim (capped at 1KB)
  lastUrl: string;
  lastQuery: string;          // raw query string, verbatim (capped at 1KB)
  firstSeenAt: string;
  queryTruncated: boolean;    // true if either query string exceeded 1KB and was cut
};

export const COOKIE_LEAD_UUID = 'htl_lead_uuid';
export const COOKIE_FIRST = 'htl_attr_first';
export const COOKIE_LAST = 'htl_attr_last';

const EXPIRE_DAYS = 90;
const EXPIRE_SEC = EXPIRE_DAYS * 24 * 60 * 60;
const COOKIE_OPTS = `Secure; SameSite=Lax; Path=/; Max-Age=${EXPIRE_SEC}`;

/** Cap query strings at 1KB to stay within cookie size limits. */
const MAX_QUERY_LEN = 1024;

function capQuery(q: string): { value: string; truncated: boolean } {
  if (q.length <= MAX_QUERY_LEN) return { value: q, truncated: false };
  return { value: q.slice(0, MAX_QUERY_LEN), truncated: true };
}

/** UUID v7 (timestamp-ordered). Falls back to v4 if crypto.randomUUID is missing. */
function uuidV7(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function encode(val: Attribution): string {
  return encodeURIComponent(JSON.stringify(val));
}

function decode(raw: string | null): Attribution | null {
  if (!raw) return null;
  try {
    return JSON.parse(decodeURIComponent(raw)) as Attribution;
  } catch {
    return null;
  }
}

function getCookie(cookies: string, name: string): string | null {
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : null;
}

/**
 * Read attribution state from a cookie header string.
 * Used by lead.ts (Lane C) on the server side.
 */
export function readAttribution(cookieHeader: string): {
  leadUuid: string;
  firstUrl: string;
  firstQuery: string;
  lastUrl: string;
  lastQuery: string;
  firstSeenAt: string;
  queryTruncated: boolean;
} {
  const first = decode(getCookie(cookieHeader, COOKIE_FIRST));
  const last = decode(getCookie(cookieHeader, COOKIE_LAST));
  const leadUuid = getCookie(cookieHeader, COOKIE_LEAD_UUID) || uuidV7();
  return {
    leadUuid,
    firstUrl: first?.firstUrl || '',
    firstQuery: first?.firstQuery || '',
    lastUrl: last?.lastUrl || '',
    lastQuery: last?.lastQuery || '',
    firstSeenAt: first?.firstSeenAt || '',
    queryTruncated: first?.queryTruncated || last?.queryTruncated || false,
  };
}

/**
 * Middleware handler. Called on every HTML request.
 * Sets cookies: htl_lead_uuid (write-once), htl_attr_first (write-once), htl_attr_last (overwrite).
 * Returns the Set-Cookie headers to add to the response.
 */
export function handleAttribution(url: URL, cookies: string): {
  setCookies: string[];
  attribution: Attribution;
} {
  const setCookies: string[] = [];
  const now = new Date().toISOString();
  const cappedQuery = capQuery(url.search);

  // 1. lead_uuid — write once
  let leadUuid = getCookie(cookies, COOKIE_LEAD_UUID);
  if (!leadUuid) {
    leadUuid = uuidV7();
    setCookies.push(`${COOKIE_LEAD_UUID}=${leadUuid}; ${COOKIE_OPTS}`);
  }

  // 2. first-touch — write once, never overwrite
  const first = decode(getCookie(cookies, COOKIE_FIRST));
  if (!first) {
    const firstAttr: Attribution = {
      leadUuid,
      firstUrl: url.origin + url.pathname,
      firstQuery: cappedQuery.value,
      lastUrl: url.origin + url.pathname,
      lastQuery: cappedQuery.value,
      firstSeenAt: now,
      queryTruncated: cappedQuery.truncated,
    };
    setCookies.push(`${COOKIE_FIRST}=${encode(firstAttr)}; ${COOKIE_OPTS}`);
  }

  // 3. last-touch — always overwrite
  const lastAttr: Attribution = {
    leadUuid,
    firstUrl: first?.firstUrl || url.origin + url.pathname,
    firstQuery: first?.firstQuery || cappedQuery.value,
    lastUrl: url.origin + url.pathname,
    lastQuery: cappedQuery.value,
    firstSeenAt: first?.firstSeenAt || now,
    queryTruncated: (first?.queryTruncated || false) || cappedQuery.truncated,
  };
  setCookies.push(`${COOKIE_LAST}=${encode(lastAttr)}; ${COOKIE_OPTS}`);

  return {
    setCookies,
    attribution: lastAttr,
  };
}

/**
 * Client-side: read attribution cookies and return the values for hidden fields.
 * Used by Lane B's shared client script.
 */
export function readAttributionClient(): {
  leadUuid: string;
  firstUrl: string;
  firstQuery: string;
  lastUrl: string;
  lastQuery: string;
  firstSeenAt: string;
  queryTruncated: boolean;
  fbp: string;
  fbc: string;
  fbclid: string;
} {
  const cookies = document.cookie;
  const first = decode(getCookie(cookies, COOKIE_FIRST));
  const last = decode(getCookie(cookies, COOKIE_LAST));
  const leadUuid = getCookie(cookies, COOKIE_LEAD_UUID) || '';

  // fbp/fbc from Meta cookies
  let fbp = '';
  let fbc = '';
  let fbclid = '';
  const cookiePairs = cookies.split('; ');
  for (const c of cookiePairs) {
    if (c.startsWith('_fbp=')) fbp = c.slice(5);
    if (c.startsWith('_fbc=')) fbc = c.slice(5);
  }

  // Try to extract fbclid from last-touch query
  if (last?.lastQuery) {
    const params = new URLSearchParams(last.lastQuery);
    fbclid = params.get('fbclid') || '';
  }

  // Fallback: synthesize fbc from fbclid if missing
  if (!fbc && fbclid) {
    fbc = `fb.1.${Math.floor(Date.now() / 1000)}.${fbclid}`;
  }

  return {
    leadUuid,
    firstUrl: first?.firstUrl || '',
    firstQuery: first?.firstQuery || '',
    lastUrl: last?.lastUrl || '',
    lastQuery: last?.lastQuery || '',
    firstSeenAt: first?.firstSeenAt || '',
    queryTruncated: first?.queryTruncated || last?.queryTruncated || false,
    fbp,
    fbc,
    fbclid,
  };
}
