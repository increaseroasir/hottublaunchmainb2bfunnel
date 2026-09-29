// htl-alert-webhook — Task 2 / D2.
// Accepts a POST from the funnel worker and forwards it to Telegram.
// This worker existing (and its URL being set as ALERT_WEBHOOK_URL on
// hottublaunch-main) is what turns a three-month silent outage into a
// ten-minute one.
//
// Deploy (from workers/alert-webhook/):
//   npx wrangler deploy
//   op read 'op://<agency vault>/<item>/TELEGRAM_BOT_TOKEN' | npx wrangler secret put TELEGRAM_BOT_TOKEN
//   printf '%s' '<chat id>' | npx wrangler secret put TELEGRAM_CHAT_ID
//   openssl rand -hex 24 | npx wrangler secret put ALERT_SECRET   # same value on hottublaunch-main
// Then on the funnel worker:
//   printf '%s' 'https://htl-alert-webhook.<account>.workers.dev' | npx wrangler secret put ALERT_WEBHOOK_URL
//
// Proof (per the work order): break the GHL key on purpose, watch the
// Telegram message arrive, screenshot it.

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ALERT_SECRET?: string;
}

function fmt(body: Record<string, unknown>): string {
  const alert = String(body.alert || 'ALERT');
  const site = String(body.site || 'unknown-site');
  const lines = [`🚨 ${alert}`, `site: ${site}`];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'alert' || k === 'site') continue;
    const val = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`${k}: ${String(val).slice(0, 400)}`);
  }
  return lines.join('\n').slice(0, 3900); // Telegram hard limit 4096
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST') {
      return new Response('htl-alert-webhook: POST alerts here', { status: 200 });
    }
    if (env.ALERT_SECRET && req.headers.get('x-alert-secret') !== env.ALERT_SECRET) {
      return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401 });
    }
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      console.error('alert-webhook: TELEGRAM secrets not set');
      return new Response(JSON.stringify({ ok: false, error: 'not configured' }), { status: 503 });
    }
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = { alert: 'RAW', raw: await req.text() };
    }
    const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: fmt(body), disable_web_page_preview: true }),
    });
    if (!tgRes.ok) {
      // Log status + body — this worker must never fail silently either.
      console.error('Telegram send FAILED:', tgRes.status, (await tgRes.text()).slice(0, 300));
      return new Response(JSON.stringify({ ok: false, status: tgRes.status }), { status: 502 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  },
};
