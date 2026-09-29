#!/usr/bin/env node
// scripts/stub-server.mjs — Lane F test double for every external service the
// funnel talks to: Meta CAPI, GHL upsert, Google token + Sheets, the alert
// webhook. Records everything it receives so the smoke test can assert on the
// EXACT payloads the worker sent — not on what the code looks like.
//
//   node scripts/stub-server.mjs [port]     (default 8788)
//
// Control endpoints:
//   GET  /__state   → full recorded state
//   POST /__reset   → wipe state
//   POST /__fail    → {"ghl":401} / {"capi":500} / {} to clear — force failures

import http from 'node:http';

const PORT = Number(process.argv[2] || 8788);

let state;
function reset() {
  state = { capi: [], ghl: [], alerts: [], sheetRows: [], tokenCalls: 0, fail: {} };
}
reset();

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  const raw = await readBody(req);
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { _raw: raw }; }

  // --- control ---
  if (path === '/__state') return send(res, 200, state);
  if (path === '/__reset') { reset(); return send(res, 200, { ok: true }); }
  if (path === '/__fail') { state.fail = body || {}; return send(res, 200, { ok: true, fail: state.fail }); }

  // --- Meta CAPI: POST /capi/{pixelId}/events ---
  if (path.startsWith('/capi/') && path.endsWith('/events')) {
    if (state.fail.capi) {
      return send(res, Number(state.fail.capi) || 500, { error: { message: 'stub forced CAPI failure' } });
    }
    const pixelId = path.split('/')[2];
    const events = body?.data || [];
    for (const e of events) state.capi.push({ pixelId, ...e });
    return send(res, 200, { events_received: events.length, fbtrace_id: 'stub' });
  }

  // --- GHL: POST /ghl/contacts/upsert ---
  if (path === '/ghl/contacts/upsert') {
    if (state.fail.ghl) {
      return send(res, Number(state.fail.ghl) || 401, { message: 'Invalid JWT' });
    }
    state.ghl.push({ auth: req.headers.authorization || '', body });
    return send(res, 200, { contact: { id: 'stub-ghl-' + state.ghl.length } });
  }

  // --- Google OAuth token ---
  if (path === '/goog/token') {
    state.tokenCalls++;
    return send(res, 200, { access_token: 'stub-google-token', expires_in: 3600 });
  }

  // --- Google Sheets emulation ---
  // GET  /sheets/spreadsheets/{id}/values/'TAB'!B:B          → column B
  // PUT  /sheets/spreadsheets/{id}/values/'TAB'!A{n}         → replace row n
  // POST /sheets/spreadsheets/{id}/values/'TAB':append       → append row
  if (path.startsWith('/sheets/spreadsheets/')) {
    const m = path.match(/\/values\/(.+)$/);
    const range = m ? m[1] : '';
    if (req.method === 'GET' && range.includes('!B:B')) {
      return send(res, 200, { values: state.sheetRows.map((r) => [String(r[1] ?? '')]) });
    }
    if (req.method === 'POST' && range.endsWith(':append')) {
      const rows = body?.values || [];
      for (const r of rows) state.sheetRows.push(r);
      return send(res, 200, { updates: { updatedRows: rows.length } });
    }
    if (req.method === 'PUT') {
      const rm = range.match(/!A(\d+)$/);
      const n = rm ? Number(rm[1]) : 0;
      const rows = body?.values || [];
      if (n >= 1 && rows.length) {
        state.sheetRows[n - 1] = rows[0];
        return send(res, 200, { updatedRows: 1 });
      }
      return send(res, 400, { error: 'bad range ' + range });
    }
    return send(res, 404, { error: 'unhandled sheets call: ' + req.method + ' ' + range });
  }

  // --- alert webhook ---
  if (path === '/alert') {
    state.alerts.push({ secret: req.headers['x-alert-secret'] || '', body });
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'stub: unhandled ' + req.method + ' ' + path });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT}`);
});
