# hottublaunch.com — Tracking Work Order

Scored against `FUNNEL_CHECKLIST_PLUMBING.md`. B2B opt-in = CORE + B2B = **73 items**.
Current: **19 done · 4 partial · 7 unverified · 43 open.**

Every item below has: **what it is · why it matters · exactly what to do · what proves it done.**
Nothing counts as complete without the proof. "It should work" is not proof.

---

## HOW TO PARALLELIZE THIS

Seven lanes. **File ownership is exclusive — do not touch a file another lane owns.**

| Lane | Owns | Depends on |
|---|---|---|
| **A — Attribution core** | `src/middleware.ts`, `src/lib/attribution.ts` | none |
| **B — Page capture + submit** | the 6 page/component files | A's contract (defined below — start immediately) |
| **C — Lead endpoint** | `src/pages/api/lead.ts`, migrations | none |
| **D — Infra & config** | `wrangler.toml`, secrets, headers, alerts worker | none |
| **E — Indexing & assets** | `astro.config.ts`, `robots.txt`, sitemap, image tags | none |
| **F — Gates & smoke test** | `scripts/` | A, B, C merged |
| **G — Human (Alex)** | Meta Events Manager, GHL, 1Password | none |

### The contract between A and B — agree on this first, then both build against it

Lane A exposes, from `src/lib/attribution.ts`:

```ts
type Attribution = {
  leadUuid: string          // cookie, minted on first request
  firstUrl: string          // full URL of first ever page view, never overwritten
  firstQuery: string        // raw query string of that first view, verbatim
  lastUrl: string           // most recent page URL
  lastQuery: string         // most recent raw query string
  firstSeenAt: string       // ISO
}
```

Cookies written by middleware: `htl_lead_uuid`, `htl_attr_first`, `htl_attr_last`.
Lane B reads them; Lane C reads them off the request header. Nobody parses UTMs in a
page component ever again.

---

# LANE A — ATTRIBUTION CORE
Owns `src/middleware.ts`, `src/lib/attribution.ts`. Nothing exists today.

### A1. Capture runs in middleware, at the request layer
**What:** An Astro middleware that runs on every HTML request before any page renders.
**Why:** Today capture runs inside each page's `captureTracking()`, which executes *after*
the browser has already navigated. By then the query string is gone. This is the root
cause of six separate bugs.
**Do:** Create `src/middleware.ts`. Run on every request whose `Accept` includes
`text/html`. Skip `/api/*` and static assets.
**Proof:** Land on `/ppr?utm_source=X` with JS disabled. The cookies are still set.
That's only possible from the request layer.

### A2. Raw query string stored verbatim
**What:** Store the entire `location.search` string as-is, unparsed, including params we
don't recognize.
**Why:** Whitelisting drops `mb`, `ttclid`, `msclkid`, `gbraid`, and every future param.
You cannot recover a param you never stored.
**Do:** `url.search` → `htl_attr_first.firstQuery` and `htl_attr_last.lastQuery`. No
parsing, no re-encoding, no filtering.
**Proof:** Land with `?utm_source=X&weird_param=42&mb=999`. Decode the cookie. All three
present, byte-identical.

### A3. First URL stored separately, never overwritten
**What:** The complete URL of the visitor's first page view, held for the whole session.
**Why:** `event_source_url` and `landingUrl` are supposed to say where the visitor
*entered*, not where they were standing when they submitted. Today it records `/ppr` even
if they landed on `/`.
**Do:** Write `firstUrl` only if `htl_attr_first` does not already exist. Long expiry
(90d). Never touch it again.
**Proof:** Land on `/?utm_source=X`, navigate to `/ppr`, then `/apply`. `firstUrl` is
still the homepage with its params.

### A4. First-touch and last-touch are separate stores
**What:** Two cookies. First is immutable. Last updates every request.
**Why:** You need both — first-touch answers "which ad created this lead," last-touch
answers "what were they looking at when they converted."
**Do:** `htl_attr_first` (write-once, 90d) and `htl_attr_last` (overwrite, 90d).
**Proof:** Land tagged, then land again with different UTMs. First unchanged, last updated.

### A5. Cookie, not sessionStorage
**What:** All attribution state lives in cookies.
**Why:** sessionStorage dies when the tab closes and **the server cannot read it** — which
is why `/api/lead` receives empty strings today while the real values sit in the browser.
**Do:** `Secure`, `SameSite=Lax`, `Path=/`, `HttpOnly=false` (Lane B reads them client-side
for the pixel), 90-day expiry.
**Proof:** `document.cookie` shows them. Close the tab, reopen, still there. A server-side
`console.log(request.headers.get('cookie'))` shows them.

### A6. URL param names read correctly
**What:** An explicit map from URL param name → internal field name.
**Why:** **This is the single biggest bug on the site.** `params.get('utmSource')` returns
null on every page because the URL carries `utm_source`. Five UTMs, six pages, all empty,
every submit, since launch.
**Do:** One map in `src/lib/attribution.ts`:
```
utm_source -> utmSource      fbclid  -> fbclid
utm_medium -> utmMedium      gclid   -> gclid
utm_campaign -> utmCampaign  msclkid -> msclkid
utm_content -> utmContent    ttclid  -> ttclid
utm_term -> utmTerm          mb, id  -> passthrough
```
Never call `params.get()` with a camelCase name again.
**Proof:** Land with all five UTMs. Decode `htl_attr_first`. All five have real values.

### A7. `_fbc` synthesized from `fbclid`  ✅ ALREADY DONE
Confirmed at `lead.ts:166`. **Do not touch.** Lane C keeps it.

### A8. Every ad param survives into the submit payload
**What:** End-to-end proof, not a code change.
**Why:** This is the acceptance test for the entire lane.
**Do:** Nothing extra — it falls out of A1–A6 plus Lane B.
**Proof:** Land on `/?utm_source=TESTSRC&utm_medium=cpc&utm_campaign=C1&utm_term=A1&utm_content=AD1-name&fbclid=FBC&gclid=GC&mb=999`, click through to `/ppr`, submit. **Paste the POST body with a real value in every attribution field.**

### A9. lead_uuid minted on arrival
**What:** The identity cookie is created on the visitor's first request, before any form
exists.
**Why:** Today it's minted inside `captureTracking()` on a form page. Someone who lands,
reads, and leaves has no identity — you can't recognize them, can't attribute a later
visit, can't build partial-lead logic.
**Do:** In middleware: if `htl_lead_uuid` absent, mint a UUID v7, set the cookie, 90 days.
**Proof:** Load the homepage only. `document.cookie` contains `htl_lead_uuid`. Never
touched a form.

### A10. Returning visitor recognized, not duplicated
**What:** Same browser returning gets the same `lead_uuid`.
**Why:** Otherwise every visit is a new person and dedup can never work.
**Do:** Never re-mint if the cookie exists. That's the whole rule.
**Proof:** Land, note the uuid, close the tab, come back tomorrow — same uuid.

---

# LANE B — PAGE CAPTURE + SUBMIT
Owns `ppr.astro`, `apply.astro`, `profit-playbook.astro`, `case-study.astro`,
`webinar-registration.astro`, `LeadForm.astro`. **Six files, one pattern, apply it identically.**

### B1. Delete every `captureTracking()` implementation
**What:** Remove the per-page attribution script entirely.
**Why:** It's duplicated six times, it's the source of the camelCase bug, and it runs too
late to be correct. It cannot be fixed in place — it must be deleted.
**Do:** Delete the function from all six files. Replace with a single import that reads
the cookies Lane A set.
**Proof:** `grep -rn "captureTracking" src/` returns nothing but the shared util.

### B2. Hidden fields populate from the attribution cookies
**What:** The form's hidden inputs read from `htl_attr_first` / `htl_attr_last`.
**Why:** The values are already correct by the time the page renders — the page just has
to read them instead of re-deriving them from a URL that no longer has them.
**Do:** One shared client script. Read cookie, decode, populate. Include `firstQuery` raw
as its own field.
**Proof:** View source on `/ppr` after a tagged click-through from `/`. Every hidden field
has a value.

### B3. CTA links carry the query string
**What:** Every internal link that moves a visitor toward a form appends the current
query string.
**Why:** Today CTAs are bare (`/ppr`, `/apply`). Clicking from the homepage strips every
param at the first hop. Even with middleware this matters — it keeps the URL honest and
makes each step independently shareable and retargetable.
**Do:** `href={path + Astro.url.search}` on every CTA in every page and component.
**Proof:** Land on `/?utm_source=X`, click the CTA, read the address bar. Params present.

### B4. Submit via `fetch`, not native form POST
**What:** Intercept submit, POST as JSON, read the JSON response, then fire the pixel,
then navigate.
**Why:** Three things break with a native POST: the browser gets no response body so it
can't read the `duplicate` flag; the navigation kills the in-flight pixel beacon; and the
server can't be authoritative for the event id.
**Do:**
```
e.preventDefault()
const res = await fetch('/api/lead', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
const { ok, leadUuid, eventId, duplicate, redirect } = await res.json()
if (ok && !duplicate) fbq('track','Lead',{},{eventID:eventId})
window.location = redirect
```
**Proof:** Network tab shows an XHR to `/api/lead` returning JSON, then a request to
`facebook.com/tr`, then the navigation. In that order.

### B5. Server's event id is the one the pixel uses
**What:** Stop minting `eventId` in the browser.
**Why:** Two systems minting the same identifier is how dedup silently breaks. One
authority: the server.
**Do:** Remove `crypto.randomUUID()` for eventId. Use the `eventId` from the JSON response.
**Proof:** `grep -rn "randomUUID" src/pages src/components` shows no eventId minting.
Events Manager shows browser and server events sharing the id, server marked Deduplicated.

### B6. Browser half gated on `duplicate === false`
**What:** If the server says this is a duplicate, the browser fires nothing.
**Why:** Otherwise a refresh or a double-submit sends a second conversion to Meta and your
cost-per-lead lies to you.
**Do:** The `if (ok && !duplicate)` in B4. That's it.
**Proof:** Submit the same email+phone twice. Second submit: no `facebook.com/tr` request.

### B7. Advanced Matching on all six pages
**What:** `fbq('init', PIXEL, {em, ph, fn, ln, external_id})` with SHA-256 hashed values,
before the Lead event.
**Why:** Without it the browser event carries only IP and user agent — the weakest possible
match. `/apply`, `/ppr` and `LeadForm` have it; `profit-playbook`, `case-study`, and
`webinar-registration` do not.
**Do:** Same helper, all six. Normalize identically to the server: email lowercased and
trimmed, phone digits-only with country code.
**Proof:** Events Manager → the browser Lead's "Advanced matching parameters" lists more
than IP address and User agent.

### B8. Consent checkbox is captured
**What:** The checkbox state **and the exact text rendered next to it** go into the payload.
**Why:** `/ppr` displays consent text and captures none of it. A boolean is worthless in a
TCPA dispute — you must be able to show what the person actually saw.
**Do:** Add hidden fields: `consentGiven`, `consentText` (the exact string), `consentVersion`,
`consentUrl`. Populate from the DOM at submit.
**Proof:** POST body contains the full consent sentence verbatim, not `true`.

### B9. Input attributes for auto-detection
**What:** `type="email"`, `type="tel"`, and meaningful `name` attributes on every input.
**Why:** Meta's automatic advanced matching regex-scans form fields. Generic or UUID field
names defeat it — you lose free match quality.
**Do:** Audit all six forms. `name="email"`, `name="phone"`, `name="first_name"`,
`name="last_name"`.
**Proof:** View source, every input has both.

---

# LANE C — LEAD ENDPOINT
Owns `src/pages/api/lead.ts` and migrations. **Nobody else edits this file.**

### C1. Accept JSON, return JSON
**What:** Handle `Content-Type: application/json` and always respond with a JSON body.
**Why:** The 303 redirect gives the browser nothing to act on. Everything in Lane B
depends on this.
**Do:** Parse JSON, respond `{ok, leadUuid, eventId, duplicate, redirect:'/confirmed'}`.
Keep the form-data + 303 path as a no-JS fallback.
**Proof:** `curl -X POST -H 'Content-Type: application/json' -d '{...}'` returns a JSON
body containing all five keys.

### C2. Server mints the event id
**What:** Server generates `eventId` and returns it. Ignore any browser-supplied value.
**Why:** One authority. See B5.
**Do:** Always `uuidV7()`. Delete the `if (!eventId)` fallback — it should be
unconditional.
**Proof:** Send a POST with `eventId: "ATTACKER"`. Response contains a different id, and
the CAPI payload uses the server's.

### C3. 24-hour duplicate suppression
**What:** Before firing conversions, check for a lead in the last 24h with the same email
OR the same last-10 phone digits.
**Why:** Without it, one person submitting twice becomes two conversions, two CRM contacts,
and a CPL that reads better than reality.
**Do:** One indexed query. Normalize first: email lowercase/trim, phone digits-only, compare
last 10. Add an expression index on `substr(phone,-10)`.
**Proof:** Submit twice. Second response has `duplicate: true`, no CAPI call in the logs,
lead still stored.

### C4. A prior *failed* conversion allows a retry
**What:** Dedup keys on successful conversions only.
**Why:** If a CAPI call errored, that lead never reached Meta. Suppressing the retry means
losing it permanently.
**Do:** Store `conversion_status` per lead. `FAILED` → allow retry. `OK` → suppress.
**Proof:** Force a CAPI failure, resubmit, confirm it retries.

### C5. Suppression is ad-signal only
**What:** A duplicate is still written to D1, still synced to GHL, still appended to the
sheet. Only the pixel and CAPI are suppressed.
**Why:** A duplicate submit is still a human trying to reach you. Never drop the record.
**Proof:** After the second submit: D1 has the row, GHL has the contact, sheet has the
line, Meta has one event.

### C6. No silent catch
**What:** Every failure path logs the HTTP status and full response body, writes a status
column on the lead row, and fires the alert webhook.
**Why:** The GHL 401 ran for months invisibly because the catch logged only `(e).name`.
That single line cost you every CRM record on the site.
**Do:** Replace every catch. Log `status` + `await res.text()`. Set
`ghl_status`/`sheet_status`/`capi_status`. Fire the alert.
**Proof:** Break the GHL key on purpose. The log shows `401 {"message":"Invalid JWT"}`,
the row shows the failure, Telegram gets a message.

### C7. Sheet is a projection, upserted by lead id
**What:** One lead, one row, forever. Updates in place.
**Why:** Append-only means a resubmitting lead appears twice and the sheet stops matching
the database.
**Do:** Look up the row by `lead_uuid` and update, or append if absent.
**Proof:** Submit, then update the same lead. Sheet has one row, current values.

### C8. Hashed PII completeness on CAPI
**What:** `em`, `ph`, `fn`, `ln` are present today. Add `zp` and `ct` **if the form collects
them** — otherwise mark this item N/A in writing.
**Why:** Every extra hashed identifier raises Event Match Quality.
**Proof:** Events Manager → server event → User data keys lists everything collected.

### C9. `event_source_url` is the real landing URL
**What:** Send `firstUrl` from the attribution cookie, not the submitting page.
**Why:** Meta attributes and models on this. `/ppr` when they entered on `/` is wrong data.
**Do:** Read `htl_attr_first` from the request cookie header, use its `firstUrl`.
**Proof:** Land on `/`, submit from `/ppr`, check the CAPI payload — `event_source_url` is
the homepage URL with its params.

### C10. Consent stored
**What:** Persist `consent_given`, `consent_text`, `consent_version`, `consent_url`,
`consent_at` in D1, and push the text to GHL as a custom field.
**Why:** This is the record you produce if a TCPA complaint lands. A boolean is not a record.
**Do:** Migration to add the columns. Write them on insert. Map to a GHL custom field.
**Proof:** Query the row. The full consent sentence is in it.

### C11. Uncontactable-by-automation flag
**What:** A lead with no consent record is marked so nothing automated ever texts or calls it.
**Why:** Legacy leads and no-JS submits will have no consent. They can be dialed by a human;
they must not enter an automated sequence.
**Do:** `contactable` column, default false, true only when consent captured. Tag it in GHL.
**Proof:** Submit a lead without consent. Row shows `contactable=0`, GHL contact carries
the tag.

### C12. Real dollar values on downstream events
**What:** Lead carries a modeled value; stage events carry real numbers.
**Why:** Meta optimizes toward value when you give it value. Count-only optimization treats
your worst lead the same as your best client.
**Do:** `value` + `currency` on the Lead event. Stage endpoint sends real amounts.
**Proof:** Events Manager shows a value on the Lead event.

### C13. CRM stage push-back
**What:** When a lead becomes qualified / booked / showed / closed, send a corresponding
event with the actual amount.
**Why:** This is what separates a funnel that reports from a funnel that learns. Meta finds
more people like the ones who *bought*, not the ones who filled a form.
**Do:** `/api/lead-stage`, called from a GHL workflow on stage change.
**Proof:** Move a test opportunity through every stage. One event per stage in Events
Manager, with values.

### C14. Stage endpoint dedupes on (lead, event)
**What:** The same stage event for the same lead can only fire once.
**Why:** GHL workflows retry, and someone will move a card backward and forward.
**Do:** `lead_events` table with a unique constraint on `(lead_uuid, event_name)`.
**Proof:** Fire the same stage twice. Second is a no-op.

---

# LANE D — INFRA & CONFIG
Owns `wrangler.toml`, worker secrets, response headers, alerts. No page or endpoint edits.

### D1. GHL_API_KEY is a real PIT key
**What:** Replace the `ops_` gateway key with the `pit-` Private Integration Token.
**Why:** **This is the single most expensive bug on the site.** GHL returns 401 on every
submit. Zero production leads have ever reached the CRM.
**Do:** `op read op://HTL B2B/GHL/pit_key` piped into `wrangler secret put`. Confirm it
starts with `pit-` before pushing. Value never touches disk or an LLM context.
**Proof:** Direct POST to the GHL upsert endpoint returns 200 with a `contact.id`.

### D2. ALERT_WEBHOOK_URL set and proven
**What:** A live webhook that reaches you within seconds.
**Why:** Every failure so far was invisible. Alerting is what turns a three-month outage
into a ten-minute one.
**Do:** Small Worker that accepts a POST and forwards to Telegram (bot token is in the
agency vault). Set the URL as a secret.
**Proof:** Force a failure. Message arrives. Screenshot it.

### D3. Permissions-Policy for Client Hints
**What:** Response header allowing high-entropy UA hints.
**Why:** User-agent strings are being throttled industry-wide. Client Hints restore device
model and platform version for Meta's matching. Free lift on mobile.
**Do:** Add to the Worker response headers:
```
Permissions-Policy: ch-ua-model=(*), ch-ua-platform-version=(*), ch-ua-full-version=(*)
```
**Proof:** `curl -I` shows the header. Meta events start carrying `chmd`/`chpv`/`chfv`.

### D4. Confirm no test event code is committed
**What:** `META_TEST_EVENT_CODE` must never exist in the repo.
**Why:** A committed test code routes production conversions into the test stream. Meta
never learns from them.
**Do:** `grep -rn "TEST_EVENT_CODE" src/ wrangler.toml`. Must be empty.
**Proof:** Paste the empty grep result.

---

# LANE E — INDEXING & ASSETS
Owns `astro.config.ts`, `public/robots.txt`, sitemap config, image tags.

### E1. `noindex` on every paid landing page
**What:** `<meta name="robots" content="noindex">` on pages that only receive paid traffic.
**Why:** Keeps Google from ranking a page never written for search, hides your offers from
competitors' SERP snooping, and keeps organic traffic out of your paid conversion data.
**Do:** Audit all six. Add where missing. Leave genuinely organic pages indexed.
**Proof:** View source on each. Screenshot the tag.

### E2. robots.txt disallows the paid paths; sitemap excludes them
**What:** Belt and suspenders on E1.
**Why:** `noindex` needs the page crawled to be seen; robots + sitemap exclusion is the
second layer.
**Proof:** `curl /robots.txt` and `curl /sitemap-index.xml`. Paid paths absent from the
sitemap, disallowed in robots.

### E3. Image and asset basics
**What:** Explicit `width`/`height` on every image, `loading="lazy"` below the fold, WebP
for photos, SVG for icons, async on non-critical scripts.
**Why:** Missing dimensions cause layout shift, which hurts both conversion rate and
Meta's landing page experience score.
**Proof:** Lighthouse mobile: CLS under 0.1. Paste the score.

---

# LANE F — GATES & SMOKE TEST
Owns `scripts/`. Runs after A, B, C merge.

### F1–F8. The pre-launch smoke test, as a script
**What:** One command that walks the live funnel and fails loudly.
**Why:** Every defect found this week would have been caught by this script on day one.
Nobody ran the checks because nothing forced them.
**Do:** Script these, each failing the build on its own:
1. Every route returns 200 — **including `/confirmed`**
2. Tagged walk end-to-end; assert every attribution field non-empty in the payload
3. One submit → exactly one deduped event pair
4. Same email+phone again → `duplicate: true`, no browser beacon
5. Thank-you reload → no events
6. Record present in D1 **and** GHL **and** the sheet
7. Stage progression → one value event per stage
8. No test event code, no `*.private.json`, no secret-shaped literals staged
**Proof:** For each gate: reintroduce its defect, show it **RED**, restore, show green.
Paste the failing output. **A gate that has only ever passed has never been tested.**

### F9. Clean up test leads
**What:** Remove every audit lead from D1, GHL, and the sheet.
**Why:** They're currently sitting in the pipeline looking like real applicants.
**Proof:** Query each system for the test emails. Zero rows.

---

# LANE G — HUMAN (ALEX)
No code. Do these in parallel with everything above.

### G1. Ad URL template
Set in Meta Events Manager → dataset → URL parameters:
```
utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}-{{ad.name}}
```
**Why:** IDs are stable and never change when you rename something; names are readable in
reports. Ad-name level is what lets you see which *creative* works, not just which campaign.
Keep ad names free of spaces and `&`.

### G2. Reserved slots for other platforms
Leave empty `gclid=`, `msclkid=`, `ttclid=` in the template so one URL shape serves every
platform when you add them. Lane A's raw-query storage picks them up automatically.

### G3. Automatic Advanced Matching — verify ON
Events Manager → dataset → Settings. **Why:** free match-quality lift, zero code.

### G4. Structured Site Data — verify ON
Same settings page. **Why:** feeds page context into Meta's model at no cost.

### G5. Decide the conversion event name
`Lead` vs `CompleteRegistration` vs custom, then A/B it. **Why:** `Lead` is heavily gamed
across lead-gen and can carry lower auction priority in some verticals. Worth testing once
you have volume — not before.

### G6. B2B qualification rules
Decide and write down: which answers disqualify, whether personal-domain emails
disqualify, and where disqualified traffic goes. **Why:** Disqualification is a feature —
it keeps your CPL honest and your calendar clean. Lane C enforces whatever you decide.

---

# THE ORDER THAT MATTERS

Five items unblock the most value. Everything else can run in parallel behind them.

1. **D1** — GHL PIT key. No CRM record exists without it.
2. **A6** — the camelCase/snake_case map. One bug, six pages, every UTM on the site.
3. **D2** — alerts. So failure #3 doesn't run for three months like #1 did.
4. **C1 + B4** — JSON response and fetch submit. Unblocks dedup, server event id, and the beacon.
5. **B8 + C10** — consent capture. Blocks automated SMS until it exists.

Kill those five and the score goes from 19/73 to roughly 35/73.

---

# RULES FOR EVERY AGENT

- **Runtime claims get a browser tab.** If you didn't watch the request in the Network
  tab, it didn't happen. Source code that looks right is not evidence.
- **Cite file and line, or say "not implemented."** Never describe a plan as though it
  were built.
- **A check that has only ever passed has never been tested.** Break it, see it red,
  restore it.
- **Do not invent a mechanism to explain something you can't verify.** Say "I don't know"
  and go look. Two wrong theories have already cost hours on this project.
- **Stay in your lane's files.** Cross-lane edits cause merge conflicts and silent
  regressions.
- **No push, no deploy without explicit approval.**
