// Single source of truth for the consent record (B8/C10).
// The rendered checkbox label and the stored consent_text MUST be the same
// string — a TCPA defense shows what the person actually saw.
// Bump CONSENT_VERSION whenever CONSENT_TEXT changes, never edit in place.

export const CONSENT_VERSION = 'htl-b2b-v1-2026-08-20';

export const CONSENT_TEXT =
  'I agree to terms & conditions provided by Hot Tub Launch. By providing my phone number and email, I agree to receive messages from Hot Tub Launch regarding my application.';
