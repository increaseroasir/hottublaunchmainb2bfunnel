# Production source baseline

## Current release — September 29, 2026

The live website now runs the phone/backend repair from source `7db66ae7e888593ceece9b8fdbce81e72c6fe257`, merged into main through [PR #1](https://github.com/increaseroasir/hottublaunchmainb2bfunnel/pull/1) at `272365985d0ba63e1e8bae66c17a1634821d7070`. The merge tree exactly matches the deployed source. Later documentation-only commits do not require rebuilding the application.

- Worker: `hottublaunch-main`, both public hostnames.
- Version: `89485b18-07c3-46c8-b842-6f78b0f567d4`, 100% traffic.
- Deployment: `2ef7a1ae-c8f0-47b0-a3cd-9a9701fb4445`, September 29 at 06:43:39 UTC / 02:43:39 Detroit.
- Deployment annotation names the exact source commit above.
- Artifact manifest SHA-256: `58e0160b3e80c194e50a73a54f9e3d0b125d289ed404da995719fcd957607395`; all 113 build files verified before upload, excluding local test `.dev.vars`.
- D1 migration `0003_sheet_row_reservations.sql` applied and schema read back. Existing integration secrets retained; four verified non-secret CRM custom-field bindings added.

All five capture forms and the API now require a valid phone and normalize it to E.164. This verifies number format, not ownership or reachability. The release also adds independent Google lead events, additive CRM tags and qualification mapping, CRM phone-conflict detection before intake tags, explicit RAW Sheet rows reserved through D1, stable retry event IDs with 24-hour rollover, and missing alert paths. No historical missing numbers were invented or backfilled. GHL-hosted funnels and workflows are separate from this release.

Acceptance: source check passed with zero errors/warnings and three existing hints; build passed; 24 local smoke gates passed, including concurrency and injected outages. Client tests cover absent/throwing Meta, duplicates and failures. All five changed forms were checked on desktop/mobile locally. Public checks after release: 13 pages HTTP 200, all five required-phone inputs, six changed public scripts matching the reviewed artifact, and three invalid-phone API requests rejected with HTTP 400. The live playbook showed the phone error and retained values. D1 remained at 57 leads with the same latest-update timestamp and zero reservations before/after these invalid tests.

Subsequent authorized live acceptance on September 29 passed the public check-territory form, updating an existing CRM contact and writing a consistent 31-column projection row. A same-browser repeat reused the lead/event IDs and the reserved Sheet row, increased the submission count, and suppressed a second explicit lead conversion. Existing CRM tags were preserved. The test contact had no active workflows afterward. This proves existing-contact capture and duplicate handling, not a new-contact intake sequence.

The first Google Analytics `generate_lead` request returned HTTP 204 with the server event ID; the first server Meta CAPI status was `ok:200`. The browser Meta Lead request used the same ID but was blocked by the existing client, so browser delivery and platform deduplication/report attribution are not established. Exact lead API response bodies were unavailable after navigation; acceptance relies on HTTP 200, the confirmation page, captured event behavior, and owning-system readback. The site loads GA4 directly (`G-Z9RVMJNMLQ`); no GTM container was observed in deployed markup or captured traffic. Platform administrative settings, real alert receipt, new-contact intake, actual reply/booking/reminder acceptance and CRM replacement cutover remain unverified. Detailed private evidence is in canonical company `records/live-lead-acceptance-2026-09-29/` and `records/phone-capture-2026-09-29/`; do not copy contact details into this repository.

Rollback: restore Worker `05019c5a-0f17-4f2f-8d09-97e2ac545ed5`, preserve accepted leads and leave the additive reservation table in place. That temporarily restores the former phone/append defects. Do not sort/delete physical projection rows while the reservation writer is active; coordinate a projection rebuild from D1 if rearrangement is necessary. No recurring repair job or new spending was added.

## Historical recovered baseline — September 28

Recovered September 28, 2026 from the existing live Hot Tub Launch B2B website. This reconciliation brings GitHub up to the deployed site; it does not deploy a different website.

## Release identity

- Public domain: `https://hottublaunch.com` and its `www` hostname.
- Cloudflare Worker: `hottublaunch-main`.
- Active version: `05019c5a-0f17-4f2f-8d09-97e2ac545ed5` (version 65, 100% traffic).
- Deployment: `97f04db5-f416-457c-8fd2-7a8c68379ccf`, August 25, 2026 at 05:20:20 UTC.
- Recovery tag: `production-baseline-2026-08-25` in this repository.
- Previous GitHub main: `494cca0a8f494690f27076e6fb0d4cc751186861`, retained in Git history.

The original deployment had no Git commit annotation. Correspondence was recovered by comparing Cloudflare's current module content, the retained local build, public assets, fresh source builds, and rendered pages. Do not rewrite that history as an original Git-triggered deployment.

## Verification

The retained build matched all 34 Cloudflare Worker modules by SHA-256, including both lead APIs. All 62 publicly served client assets matched byte for byte. The `/_headers` file is deployment metadata and is not served as an asset. A local preview of the retained build matched the full HTML of all 13 public pages after replacing only the local request origin in the five pages that emit absolute URLs.

The recovered source passes `npm run build` and `npm run check` (zero errors or warnings; three existing hints). Its 78 client build files match the retained live build byte for byte. All 13 rebuilt preview pages match the public HTML after normalizing only the request origin. Of 34 generated server modules, 33 match character for character after normalizing only the known build/dependency roots and corresponding generated chunk filenames. The remaining module has equal parsed manifest data after removing the per-build generated key and sorting the same 62 asset paths. Raw server files built at a different absolute path are therefore not claimed to be byte-identical to the original upload; no substantive code or route-manifest difference was found.

Exact deployed module fingerprints are in [production-evidence/live-worker-modules.json](production-evidence/live-worker-modules.json). The source/assets/config fingerprints for this recovered baseline are in [production-evidence/source-manifest.json](production-evidence/source-manifest.json). Full local comparison evidence is held in the canonical company records under `records/website-reconciliation-2026-09-28/`.

## What was reconciled

GitHub main had older source and omitted deployed routes, shared attribution/consent logic, lead/stage handling, and proof assets. The recovered baseline includes the live Paradise and pre-call pages, lead capture pages, confirmation pages, and the existing homepage variants. A newer local pre-call styling edit was excluded from the production baseline and preserved in the original local development checkout. Runtime-neutral type annotations resolve the Paradise source-check errors.

The separate `funnel-hardening-2026-08-20` branch remains intact. Its additional calendar endpoints, field mapping, and other changes were not automatically merged into the baseline because they were not present in the verified deployed code.

The repository also retains local mock-test tools, database migrations, and separate alert-worker source. Their presence does not prove the database schema or alert Worker currently deployed matches those supporting files.

## Boundaries

This proves source/artifact correspondence within the documented comparisons. It does not establish successful live lead delivery, conversion attribution, calendar booking, or failure notification. No form submission, production smoke test, migration, secret change, or deployment was part of this reconciliation.

No GitHub Actions workflows, repository webhooks, or Cloudflare Worker build triggers were configured when inspected. Future integration changes may alter that; inspect the current trigger setup before assuming a push cannot deploy.

## Future releases

1. Start from the maintained production baseline and preserve pending local work. Review other branches explicitly.
2. Commit the intended source and build with locked dependencies. Run source checks and relevant local acceptance checks. Record limitations rather than treating a successful build as proof of live integrations.
3. Deploy only with authorization for that release. Keep the prior Cloudflare version recoverable.
4. Record the Git commit, Worker version, deployment timestamp, affected routes, and actual verification together. Update this document and the canonical company website map.
5. Leave experiments on a distinct branch. Do not leave a deployed change available only as an uncommitted file on one machine.
