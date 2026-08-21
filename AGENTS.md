# AGENTS.md — hottublaunch.com main B2B funnel

Read this cold before touching anything. It is the distilled rulebook from
`docs/HTL-WORK-ORDER.md` and the 2026-08-20 hardening pass. Every rule exists
because ignoring it cost real money.

## What this is

The agency's own B2B funnel (sells Hot Tub Launch to hot tub dealers), running
live paid Meta traffic. It is also **the lab**: what gets fixed here gets
ported to the template every client site is built from.

Stack: Astro 7 · Cloudflare Workers · D1 · GHL · Meta Pixel + CAPI · GA4.
Worker `hottublaunch-main` · D1 `hottublaunch-b2b` · Pixel `1200252438858536`
(any other pixel id you remember is a stale hallucination — do not resurrect it).
Live funnel page: `/check-territory` (`/ppr` 301s to it).

## Architecture — do not re-derive it, it is settled

- `src/middleware.ts` captures attribution at the request layer on every HTML
  request. Cookies: `htl_lead_uuid` (identity, write-once), `htl_attr_first`
  (write-once), `htl_attr_last` (overwrite). Raw query stored verbatim.
  Exposed to pages via `Astro.locals.attribution`.
- `src/lib/attribution.ts` owns the param map (snake_case URL → camelCase).
  Never call `params.get('utmSource')` — the URL carries `utm_source`.
- `src/lib/lead-client.ts` is the ONE client submit path (all six forms):
  fetch JSON → read `{ok, leadUuid, eventId, duplicate, redirect}` → fire
  pixel ONLY when `duplicate === false` with the SERVER's eventId → navigate.
  Also fires GA4 `generate_lead` + Google enhanced-conversion `user_data`,
  same gate. Never mint ids in the browser. Never add a per-page
  captureTracking().
- `src/pages/api/lead.ts` (Lane C): D1 first, then GHL/CAPI/sheet. 24h dedup
  on email OR last-10 phone; a duplicate is still stored everywhere, only ad
  signals are suppressed; a FAILED conversion allows retry. Every failure
  writes a status column AND fires the alert webhook. No silent catch, ever.
- `src/pages/api/lead-stage.ts`: stage push-back. ONE event name per real
  stage (QualifiedLead 75 / Schedule 300 / Showed 600 / Purchase real value,
  required). UNIQUE(lead_uuid, event_name) makes double sources safe — GHL
  workflow and the booking page both fire `Schedule`; first wins, second
  no-ops. Never invent new event names to dodge dedup. Browser path (no
  secret) allows ONLY Schedule, identity from cookie only.
- Consent: `src/data/consent.ts` is the single source of the rendered
  sentence. The stored consent_text must equal what the person saw. Bump
  CONSENT_VERSION on any wording change.
- Migrations: `db/migrations/`, applied with
  `wrangler d1 migrations apply hottublaunch-b2b [--local|--remote]`.

## The rules (non-negotiable)

1. **Runtime claims get a browser tab.** `npm run build` passing proves
   nothing — the utm bug passed every build for months. "The event fires"
   means you watched the request.
2. **Cite file and line, or say "not implemented."** Never describe a plan as
   though it were built.
3. **A check that has only ever passed has never been tested.** Break it, see
   RED, restore, paste the failing output. `BREAK=<mode> ./scripts/run-local.sh`.
4. **Don't invent mechanisms to explain what you can't verify.** Say "I don't
   know" and go look. Two fabricated theories have already burned hours here.
5. **Report by money impact, not order of discovery.**
6. **No push, no prod deploy without explicit approval from Alex.** Preview
   (`wrangler versions upload`) is the default for verification.
7. **Secrets:** `op read 'op://…' | wrangler secret put NAME`. Never to disk,
   never printed, never in an LLM context, never committed. G8 greps for
   secret-shaped literals and will fail the smoke run.
8. **No conversion events on page load.** Reloads must fire nothing (gate 5).
   New conversion moments go through a server-deduped endpoint with the
   browser half gated on `duplicate === false`.
9. **New page?** `robots="noindex"` prop if it's funnel/paid, add the path to
   `public/robots.txt`, add the route to `scripts/smoke.mjs` G1, keep it out
   of `public/sitemap.xml`.
10. **Delete your test leads** from D1 + GHL + sheet when done (F9). They sit
    in the pipeline looking like real applicants.

## Commands

```bash
npm run build                      # build (proves nothing about runtime)
./scripts/run-local.sh             # local D1 + stub externals + all smoke gates
BREAK=dedup ./scripts/run-local.sh # prove a gate can go red
BASE_URL=https://hottublaunch.com SMOKE_MODE=live node scripts/smoke.mjs
npx wrangler d1 migrations apply hottublaunch-b2b --remote   # prod schema
npx wrangler versions upload       # preview deploy
npx wrangler deploy                # PROD — only with Alex's explicit go
```

## Reference docs

- `docs/HTL-WORK-ORDER.md` — every item with what-proves-it-done
- `docs/EVIDENCE-2026-08-20.md` — the proof transcript for the hardening pass
- `docs/DEPLOY-HTL.md` — operator deploy runbook
- `docs/FUNNEL_CHECKLIST_PLUMBING.md` is the contract; if code disagrees with
  it, the doc wins.
