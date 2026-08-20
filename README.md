# Hot Tub Launch — Main B2B Funnel

Agency front door for **Increase ROAS / Hot Tub Launch**. Runs ads to reach hot tub store owners; leads land in the Hot Tub Launch B2B GHL sub-account.

**Live:** https://hottublaunch.com

## Stack
- Astro 7 + @astrojs/cloudflare (server mode)
- D1 (leads table)
- GHL upsert (contacts/upsert, PIT key)
- Meta Pixel + CAPI (dedup by event_id)
- Google Sheets lead vault (HTL B2B Leads)

## Pages
| Route | Source |
|---|---|
| `/` | index.html (main homepage, cream/ink/red) |
| `/homepage-draft` | homepage-draft.html (elevation pass) |
| `/homepage-ai` | homepage-ai-draft.html (dark volt theme) |

## Dev
```bash
npm install
npm run dev
npm run build
```

## Secrets (wrangler)
GHL_API_KEY, GHL_LOCATION_ID, META_PIXEL_ID, META_CAPI_TOKEN, GOOGLE_SHEETS_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY

## Deploy
```bash
npx wrangler deploy
```
