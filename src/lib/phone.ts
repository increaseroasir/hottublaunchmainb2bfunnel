import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/** A format-valid number, not proof that the lead owns or answers it. */
export function validPhoneE164(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // Bare numbers are treated as US; other countries require an explicit + prefix.
  const parsed = parsePhoneNumberFromString(raw, { defaultCountry: 'US', extract: false });
  // An extension would be lost in E.164 storage, so require a direct number.
  return parsed?.isValid() && !parsed.ext ? parsed.number : null;
}
