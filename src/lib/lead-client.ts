// src/lib/lead-client.ts — Lane B's ONE shared client script.
// Replaces every per-page captureTracking() implementation (B1).
//
// What it does, in order, on submit (B4):
//   1. preventDefault — never a native POST from the JS path
//   2. page-specific validate()
//   3. POST /api/lead as JSON, read the JSON response
//   4. fire the browser pixel ONLY when ok && duplicate === false (B6),
//      using the SERVER's event id (B5) and hashed Advanced Matching (B7)
//   5. navigate to the server-provided redirect
// If fetch itself fails, fall back to a native form POST so the lead is
// never lost (the server keeps a form-data + 303 path).
//
// This module mints NO ids. Identity comes from the middleware cookies;
// the event id comes from the server response.

import { readAttributionClient, fullUrl, META_PIXEL_ID } from './attribution';

declare global {
  // Meta pixel
  // eslint-disable-next-line no-var
  var fbq: ((...args: unknown[]) => void) | undefined;
}

type WireOptions = {
  form: HTMLFormElement;
  /** Page-specific validation; return false to block submit. */
  validate?: () => boolean;
  /** Runs after validation, before payload collection (e.g. quiz-answer capture). */
  onBeforeSubmit?: () => void;
};

function setField(form: HTMLFormElement, name: string, value: string): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement) el.value = value;
}

/**
 * B2: populate the hidden fields from the attribution cookies the middleware
 * set — including the raw firstQuery. The server re-reads the same cookies
 * authoritatively; these fields also keep the no-JS form-data path complete.
 */
export function populateHiddenFields(form: HTMLFormElement): void {
  const att = readAttributionClient();
  setField(form, 'leadUuid', att.leadUuid);
  setField(form, 'firstUrl', att.firstUrl);
  setField(form, 'firstQuery', att.firstQuery);
  setField(form, 'lastUrl', att.lastUrl);
  setField(form, 'lastQuery', att.lastQuery);
  setField(form, 'firstSeenAt', att.firstSeenAt);
  setField(form, 'landingUrl', fullUrl(att.firstUrl, att.firstQuery));
  setField(form, 'fbp', att.fbp);
  setField(form, 'fbc', att.fbc);
  setField(form, 'fbclid', att.fbclid);
  const consentUrl = form.elements.namedItem('consentUrl');
  if (consentUrl instanceof HTMLInputElement && !consentUrl.value) {
    consentUrl.value = window.location.href;
  }
}

async function sha256hex(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Normalize phone the same way the server does (strip non-digits, 10-digit → 1-prefixed)
function normPhone(p: string): string {
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = '1' + d;
  return d;
}

function fieldValue(form: HTMLFormElement, name: string): string {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement || input instanceof HTMLSelectElement
    ? input.value.trim()
    : '';
}

function collectPayload(form: HTMLFormElement): Record<string, string> {
  const payload: Record<string, string> = {};
  const fd = new FormData(form);
  fd.forEach((v, k) => {
    if (typeof v === 'string') payload[k] = v;
  });
  // B8: checkbox state + the exact rendered consent text (already in hidden
  // fields, server-rendered). consentGiven reflects the checkbox NOW.
  const terms = form.elements.namedItem('terms');
  if (terms instanceof HTMLInputElement && terms.type === 'checkbox') {
    payload.consentGiven = terms.checked ? 'true' : 'false';
  }
  return payload;
}

/** B7: hashed Advanced Matching init, identical normalization to the server. */
async function fireBrowserLead(form: HTMLFormElement, eventId: string): Promise<void> {
  if (typeof fbq !== 'function' || !eventId) return;
  const leadUuid = fieldValue(form, 'leadUuid');
  try {
    const [em, ph, fn, ln, extId] = await Promise.all([
      sha256hex(
        (fieldValue(form, 'email')).toLowerCase()
      ),
      sha256hex(normPhone(fieldValue(form, 'phone'))),
      sha256hex((fieldValue(form, 'first_name') || fieldValue(form, 'name')).toLowerCase()),
      sha256hex((fieldValue(form, 'last_name') || fieldValue(form, 'lastName')).toLowerCase()),
      leadUuid ? sha256hex(leadUuid) : Promise.resolve(''),
    ]);
    fbq('init', META_PIXEL_ID, {
      em,
      ph,
      fn,
      ln,
      external_id: extId || undefined,
    });
  } catch {
    // hashing failure never blocks the event itself
  }
  fbq('track', 'Lead', {}, { eventID: eventId });
  // Give the beacon a moment to leave before navigation kills it.
  await new Promise((r) => setTimeout(r, 300));
}

export function wireLeadForm(opts: WireOptions): void {
  const { form } = opts;
  populateHiddenFields(form);

  let submitting = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault(); // B4: fetch, never a native POST from here
    if (submitting) return;

    if (opts.validate && !opts.validate()) return;
    opts.onBeforeSubmit?.();
    populateHiddenFields(form); // refresh fbp/fbc — the pixel may have set them after load

    const button = form.querySelector('[data-submit]');
    const setBusy = (busy: boolean) => {
      submitting = busy;
      if (button instanceof HTMLButtonElement) button.disabled = busy;
    };
    setBusy(true);

    const payload = collectPayload(form);
    try {
      sessionStorage.setItem('lead_name', payload.first_name || payload.name || '');
      sessionStorage.setItem('lead_email', payload.email || '');
    } catch {}

    void (async () => {
      let data: { ok?: boolean; leadUuid?: string; eventId?: string; duplicate?: boolean; redirect?: string; error?: string };
      try {
        const res = await fetch('/api/lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        data = await res.json();
      } catch {
        // Network/parse failure: fall back to the native no-JS path so the
        // lead is never lost. form.submit() does not re-fire this handler.
        setBusy(false);
        form.submit();
        return;
      }

      if (!data.ok) {
        setBusy(false);
        const slot = form.querySelector('[data-error-for="email"], .form-error');
        if (slot) slot.textContent = data.error || 'Something went wrong — please try again.';
        return;
      }

      // B5 + B6: server's event id, browser half gated on duplicate === false
      if (data.duplicate === false && data.eventId) {
        await fireBrowserLead(form, data.eventId);
      }
      window.location.assign(data.redirect || '/confirmed');
    })();
  });
}
