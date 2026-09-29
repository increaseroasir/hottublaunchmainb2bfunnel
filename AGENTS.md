# Hot Tub Launch B2B website — AI instructions

Read `docs/PRODUCTION_BASELINE.md` before choosing a source or deployment target. This repository owns the agency's website implementation. The company knowledge home on Alex's workstation is `Documents/Company-Ops/htl`; its `CURRENT_STATE.md` and `website.md` hold company context and current operating evidence. Do not copy customer records or company archives into this public repository.

The live site is `hottublaunch.com`, Worker `hottublaunch-main`, D1 `hottublaunch-b2b`, Meta Pixel `1200252438858536`. Client store sites, the practice funnel, and the B2B sales agent are separate systems.

## Preserve the deployed baseline

`main` records the recovered production source. Other branches contain separate work; do not automatically merge a branch because it sounds newer or more complete. Preserve existing local edits. A dated file, matching heading, successful build, or configured binding does not by itself establish what is deployed or working.

Use one shared lead-submit path. Preserve D1-first capture, first/last attribution and identity, server event IDs, deduplication, consent version/text, and downstream status and alert handling. Secret values must stay out of source, logs, documents, and chat.

Every B2B lead requires a valid normalized phone in both form and API. Preserve existing CRM stop/reply tags: add tags rather than replacing them, and verify returned phone identity before applying intake tags. The Lead Vault is a projection with D1 row reservations; do not physically reorder/delete its rows without a coordinated rebuild. Read the current release document for acceptance limits and recovery.

Inspect the relevant implementation before making claims about it. Distinguish page availability, tracking markup, configured integrations, local mock tests, and observed end-to-end production delivery. Do not describe the latter as verified by a build or source inspection.

## Release upkeep

Carry authorized work through verification. A request to reconcile GitHub with the existing live site authorizes the source update; it does not require changing the live website. Follow Alex's actual authorization for future pushes, deployments, migrations, and production tests. Do not infer new authority from a historical procedure.

For a release: preserve the previous version, commit the reviewed source, build from that source with locked dependencies, deploy only when authorized, and record the commit, Cloudflare version, timestamp, affected routes, acceptance evidence, and remaining gaps in `docs/PRODUCTION_BASELINE.md`. Update the canonical company website map too when accessible. A deployment should never be left with only uncommitted source on one machine.

Use `npm run build` and relevant source checks. `scripts/run-local.sh` uses local mocks; inspect its targets first. A live smoke run can create contacts, appointments, messages, and ad events; it needs authority for those effects and appropriate cleanup. Do not submit live forms merely to check whether the page is available.
