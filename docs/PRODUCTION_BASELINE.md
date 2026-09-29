# Production source baseline

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
