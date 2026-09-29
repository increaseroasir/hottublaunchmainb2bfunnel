# Hot Tub Launch — B2B website

The agency's own website and lead funnel at https://hottublaunch.com, running on Cloudflare Worker `hottublaunch-main` with D1 database `hottublaunch-b2b`.

Read [AGENTS.md](AGENTS.md) before changes and [docs/PRODUCTION_BASELINE.md](docs/PRODUCTION_BASELINE.md) for the recovered live baseline, verification, and release rules. GitHub `main` is the maintained source for that baseline. Historical branches may contain additional work that has not been verified as live.

## Contents

- `src/pages/`: public pages, proof pages, and lead/stage APIs.
- `src/lib/`, `src/components/`, `src/data/`: shared submission, attribution, consent, and integration logic.
- `public/`: site assets, proof images, robots, and sitemap.
- `db/`: schema and migrations.
- `workers/alert-webhook/`: separate alert receiver source; the main-site baseline does not verify that receiver's deployment.
- `scripts/`: local test runner, mock services, and smoke checks.

## Local work

Use the package lock and a compatible Node runtime. `npm ci`, `npm run build`, and `npm run check` are local commands. `scripts/run-local.sh` is the local D1/mock integration harness; inspect its prerequisites and targets before use. A build or type check does not prove live lead delivery.

Secrets belong in the credential manager and Cloudflare bindings. `.dev.vars.example` contains placeholders only. Never commit `.dev.vars`, environment files, credentials, or customer exports.

Deployment is a separate authorized action. Keep GitHub aligned with the source actually released, record the commit and Cloudflare version, and verify the affected behavior. Do not run production smoke tests without authorization for their real leads, messages, and conversion events.
