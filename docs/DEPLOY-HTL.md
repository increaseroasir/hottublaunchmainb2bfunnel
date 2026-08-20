# Deploy runbook — funnel-hardening-2026-08-20

For the operator/local agent (Hermes) on Alex's machine. Assumes: repo cloned,
Cloudflare auth working (`npx wrangler whoami`), 1Password service account
token at `~/.hermes/.op.env` with read access to the **HTL B2B** vault.

Rules: secrets are piped, never written to disk, never printed, never pasted
into an LLM context. Prod promote is a decision — stop at step 6 and confirm.

```bash
git fetch origin && git checkout funnel-hardening-2026-08-20
npm ci && npm run build
```

## 1. Local gates must be green before anything touches prod

```bash
./scripts/run-local.sh        # 9/9 GREEN required
```

## 2. GHL PIT key (TASK 1 — highest value on the board)

```bash
set -a; source ~/.hermes/.op.env; set +a
# confirm the key shape without printing it:
op read 'op://HTL B2B/GHL/GHL_PIT_KEY' | head -c 4    # must print: pit-
op read 'op://HTL B2B/GHL/GHL_PIT_KEY' | npx wrangler secret put GHL_API_KEY
```

(If the item/field name differs, `op item list --vault 'HTL B2B'` to find it.)
`HTL_B2B_SERVICE_KEY` gets **retired, not replaced** — delete it wherever it
exists; nothing in this repo reads it.

**Proof:** direct upsert returns 200 + contact.id:

```bash
op read 'op://HTL B2B/GHL/GHL_PIT_KEY' | xargs -I{} curl -s -o /tmp/ghl.json -w '%{http_code}\n' \
  -X POST https://services.leadconnectorhq.com/contacts/upsert \
  -H 'Authorization: Bearer {}' -H 'Version: 2021-07-28' -H 'Content-Type: application/json' \
  -d '{"email":"pit-key-proof@hottublaunch.com","firstName":"KeyProof","locationId":"'"$(op read 'op://HTL B2B/GHL/GHL_LOCATION_ID')"'"}'
grep -o '"id":"[^"]*"' /tmp/ghl.json | head -1   # a real contact.id, then delete that contact in GHL
```

## 3. Remote migrations (additive; safe on the live DB)

```bash
npx wrangler d1 migrations apply hottublaunch-b2b --remote
```

## 4. Other secrets

```bash
openssl rand -hex 32 | npx wrangler secret put STAGE_WEBHOOK_SECRET   # rotation — old one leaked
# alert worker first:
cd workers/alert-webhook
npx wrangler deploy
op read 'op://<agency vault>/Telegram/BOT_TOKEN' | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' '<chat id>' | npx wrangler secret put TELEGRAM_CHAT_ID
openssl rand -hex 24 | npx wrangler secret put ALERT_SECRET
cd ../..
printf '%s' 'https://htl-alert-webhook.<account>.workers.dev' | npx wrangler secret put ALERT_WEBHOOK_URL
# same ALERT_SECRET value on the funnel worker:
npx wrangler secret put ALERT_SECRET
```

Optional (recommended): create two GHL custom fields and set
`GHL_CF_LEAD_UUID_ID` + `GHL_CF_CONSENT_TEXT_ID` (as secrets or [vars]) so
contacts carry `lead_uuid` (the stage workflows need it) and the consent text.

## 5. Preview deploy + live smoke

```bash
npx wrangler versions upload          # prints a preview version/URL
BASE_URL=<preview url> SMOKE_MODE=live node scripts/smoke.mjs
```

Gates that need test doubles SKIP loudly in live mode — G1/G2-contract/robots
still run. Then the browser half on the preview URL: tagged visit → submit →
Events Manager Test Events shows ONE deduped browser+server pair.

## 6. STOP — prod is a decision

With explicit approval only:

```bash
npx wrangler deploy
```

## 7. Post-deploy acceptance (TASK 8)

```
https://hottublaunch.com/?utm_source=TESTSRC&utm_medium=cpc&utm_campaign=C1&utm_term=A1&utm_content=AD1-name&fbclid=FBC&gclid=GC&mb=999
```

Click through to /check-territory, submit, prove all four: POST body full
attribution · D1 row (`wrangler d1 execute hottublaunch-b2b --remote --command
"SELECT lead_uuid, utm_source, ghl_contact_id, conversion_status FROM leads
ORDER BY id DESC LIMIT 1"`) · GHL contact with real id · ONE deduped pair in
Events Manager. Resubmit same email/phone → duplicate:true, no browser beacon,
lead still stored.

Break the GHL key once (put a junk value, submit, restore) → Telegram message
arrives → screenshot → C6/D2 proof done.

## 8. Cleanup + config (F9 / Lane G)

- Delete test leads (audittest2@example.com, smoke-*, browser-*, pit-key-proof)
  from GHL + D1 + the sheet.
- GHL: 4 workflows → POST /api/lead-stage per `src/pages/api/lead-stage.ts`.
- Events Manager: ad URL template, AAM ON, Structured Site Data ON.
- Update any ad still pointing at /ppr.
- Merge to main + push after prod is verified.
