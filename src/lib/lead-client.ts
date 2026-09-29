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
import { validPhoneE164 } from './phone';

declare global {
  // Meta pixel
  // eslint-disable-next-line no-var
  var fbq: ((...args: unknown[]) => void) | undefined;
  // Google tag queue remains callable while gtag.js is loading.
  // eslint-disable-next-line no-var
  var gtag: ((...args: unknown[]) => void) | undefined;
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

/** Browser conversions share the server event ID, independently per platform. */
async function fireBrowserLead(form: HTMLFormElement, eventId: string, phone: string): Promise<void> {
  if (!eventId) return;
  const leadUuid = fieldValue(form, 'leadUuid');
  if (typeof fbq === 'function') try {
    const [em, ph, fn, ln, extId] = await Promise.all([
      sha256hex(
        (fieldValue(form, 'email')).toLowerCase()
      ),
      sha256hex(phone.replace(/\D/g, '')),
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
  try {
    if (typeof fbq === 'function') fbq('track', 'Lead', {}, { eventID: eventId });
  } catch { /* A blocked Meta tag must not prevent Google or navigation. */ }
  if (typeof gtag === 'function') {
    try {
      gtag('set', 'user_data', {
        email: fieldValue(form, 'email').toLowerCase(),
        phone_number: phone,
      });
      gtag('event', 'generate_lead', { transaction_id: eventId });
    } catch {
      // A blocked Google tag must not interrupt the Meta event or navigation.
    }
  }
  // Give the beacon a moment to leave before navigation kills it.
  if (typeof fbq === 'function' || typeof gtag === 'function') {
    await new Promise((r) => setTimeout(r, 300));
  }
}

export function wireLeadForm(opts: WireOptions): void {
  const { form } = opts;
  populateHiddenFields(form);

  let submitting = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault(); // B4: fetch, never a native POST from here
    if (submitting) return;

    const pageValid = opts.validate ? opts.validate() : true;
    const phoneInput = form.elements.namedItem('phone');
    const phone = phoneInput instanceof HTMLInputElement ? validPhoneE164(phoneInput.value) : null;
    const phoneError = form.querySelector('[data-error-for="phone"]');
    if (phoneInput instanceof HTMLInputElement) phoneInput.setAttribute('aria-invalid', phone ? 'false' : 'true');
    if (phoneError) phoneError.textContent = phone ? '' : 'Enter a valid phone number.';
    if (!pageValid || !phone) return;
    opts.onBeforeSubmit?.();
    populateHiddenFields(form); // refresh fbp/fbc — the pixel may have set them after load

    const button = form.querySelector('[data-submit]');
    const setBusy = (busy: boolean) => {
      submitting = busy;
      if (button instanceof HTMLButtonElement) button.disabled = busy;
    };
    setBusy(true);

    const payload = collectPayload(form);
    payload.phone = phone;
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
        const slot = data.error?.toLowerCase().includes('phone')
          ? form.querySelector('[data-error-for="phone"]')
          : form.querySelector('[data-error-for="email"], .form-error');
        if (slot) slot.textContent = data.error || 'Something went wrong — please try again.';
        if (data.error?.toLowerCase().includes('phone') && phoneInput instanceof HTMLInputElement) {
          phoneInput.setAttribute('aria-invalid', 'true');
        }
        return;
      }

      // B5 + B6: server's event id, browser half gated on duplicate === false
      if (data.duplicate === false && data.eventId) {
        await fireBrowserLead(form, data.eventId, phone);
      }
      window.location.assign(data.redirect || '/confirmed');
    })();
  });
}
