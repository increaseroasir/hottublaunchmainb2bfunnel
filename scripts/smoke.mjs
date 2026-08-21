#!/usr/bin/env node
// scripts/smoke.mjs — Lane F. One command that walks the funnel and fails loudly.
// Every defect found in the 2026-08-20 audit would have been caught by this on
// day one. Exit code is non-zero on ANY red gate.
//
// Local mode (default):
//   1. node scripts/stub-server.mjs            (port 8788)
//   2. npx wrangler dev -c dist/server/wrangler.json --port 8787 ...
//   3. node scripts/smoke.mjs
//   (scripts/run-local.sh does all three)
//
// Live mode:
//   BASE_URL=https://hottublaunch.com SMOKE_MODE=live node scripts/smoke.mjs
//   — stub/D1/stage gates that need test doubles or secrets are SKIPPED and
//   say so; nothing is silently counted as covered.
//
// Red/green proof (a gate that has only ever passed has never been tested):
//   BREAK=routes|attribution|eventid|dedup|reload|ghl|stage|hygiene node scripts/smoke.mjs
//   Each BREAK reintroduces one class of defect and the matching gate must go RED.

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const STUB = process.env.STUB_URL || 'http://127.0.0.1:8788';
const MODE = process.env.SMOKE_MODE || 'local';
const BREAK = process.env.BREAK || '';
const PERSIST = process.env.PERSIST_DIR || '.wrangler-local';
const WRANGLER_CFG = 'dist/server/wrangler.json';

const TAG_QUERY =
  '?utm_source=TESTSRC&utm_medium=cpc&utm_campaign=C1&utm_term=A1&utm_content=AD1-name&fbclid=FBC&gclid=GC&mb=999';
const TAG_PARAMS = ['utm_source=TESTSRC', 'utm_medium=cpc', 'utm_campaign=C1', 'utm_term=A1', 'utm_content=AD1-name', 'fbclid=FBC', 'gclid=GC', 'mb=999'];

const results = [];
let failures = 0;

function gate(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok === false) failures++;
  const mark = ok === true ? '\x1b[32mGREEN\x1b[0m' : ok === false ? '\x1b[31mRED\x1b[0m  ' : '\x1b[33mSKIP\x1b[0m ';
  console.log(`  ${mark}  ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------- tiny cookie jar ----------
function jar() {
  const cookies = new Map();
  return {
    absorb(res) {
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1));
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    get(name) {
      return cookies.get(name) || '';
    },
    set(name, v) {
      cookies.set(name, v);
    },
  };
}

// one retry on transient socket failures (wrangler dev keep-alive churn)
async function rfetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch {
    await new Promise((r) => setTimeout(r, 500));
    return fetch(url, opts);
  }
}

async function get(path, j, extra = {}) {
  const res = await rfetch(BASE + path, {
    redirect: 'manual',
    headers: { Accept: 'text/html', ...(j ? { Cookie: j.header() } : {}), ...extra },
  });
  if (j) j.absorb(res);
  return res;
}

async function postLead(payload, j) {
  const res = await rfetch(BASE + '/api/lead', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(j ? { Cookie: j.header() } : {}),
    },
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { res, data };
}

async function stub(path, body) {
  const res = await rfetch(STUB + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return res.json();
}

function d1(sql) {
  const out = execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'hottublaunch-b2b',
    MODE === 'live' ? '--remote' : '--local',
    '--persist-to', PERSIST,
    '-c', WRANGLER_CFG,
    '--json', '--command', sql,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return parsed[0]?.results ?? [];
}

function extractHidden(html, name) {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
  return m ? m[1] : '';
}
const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const ts = Date.now();
const EMAIL = `smoke-${ts}@example.com`;
const PHONE = '555' + String(ts).slice(-7); // 10 unique-ish digits per run

async function main() {
  console.log(`\nSMOKE — base=${BASE} mode=${MODE}${BREAK ? ` BREAK=${BREAK}` : ''}\n`);
  const stubAvailable = MODE !== 'live' && (await stub('/__reset').then(() => true).catch(() => false));
  if (BREAK === 'ghl' && stubAvailable) await stub('/__fail', { ghl: 401 });

  // ============ GATE 1 — every route returns 200, including /confirmed ============
  {
    const routes = ['/', '/check-territory', '/apply', '/profit-playbook', '/case-study', '/webinar-registration', '/privacy', '/confirmed', '/thankyou', '/thankyouq'];
    if (BREAK === 'routes') routes.push('/this-route-does-not-exist');
    let bad = [];
    for (const r of routes) {
      const res = await get(r, null);
      if (res.status !== 200) bad.push(`${r}→${res.status}`);
    }
    const ppr = await get('/ppr' + TAG_QUERY, null);
    const loc = ppr.headers.get('location') || '';
    const pprOk = ppr.status === 301 && loc === '/check-territory' + TAG_QUERY;
    if (!pprOk) bad.push(`/ppr→${ppr.status} Location=${loc}`);
    gate('G1 routes 200 + /ppr 301 preserves query', bad.length === 0, bad.join(', '));
  }

  // ============ GATE 2 — tagged walk end-to-end, every attribution field non-empty ============
  const j1 = jar();
  let lead1 = null;
  {
    // land tagged on the homepage
    await get('/' + (BREAK === 'attribution' ? '' : TAG_QUERY), j1);
    const firstCookie = decodeURIComponent(j1.get('htl_attr_first'));
    const cookieCarriesAll = TAG_PARAMS.every((p) => firstCookie.includes(p));
    // click through to the funnel page (no params on the hop — middleware carries them)
    const lp = await get('/check-territory', j1);
    const html = await lp.text();
    const renderedFirstQuery = unescapeHtml(extractHidden(html, 'firstQuery'));
    const consentText = unescapeHtml(extractHidden(html, 'consentText'));
    const consentVersion = extractHidden(html, 'consentVersion');
    const renderedOk = TAG_PARAMS.every((p) => renderedFirstQuery.includes(p));

    const payload = {
      first_name: 'Smoke', last_name: 'Test', email: EMAIL, phone: PHONE,
      businessName: 'Smoke Spa Co', state: 'MI', isOwner: 'yes', monthlyVolume: '5-10',
      terms: 'on', consentGiven: 'true', consentText, consentVersion,
      consentUrl: BASE + '/check-territory',
      ...(BREAK === 'eventid' ? { eventId: 'ATTACKER-SUPPLIED-ID' } : {}),
    };
    const { data } = await postLead(payload, j1);
    lead1 = data;
    const keys = ['ok', 'leadUuid', 'eventId', 'duplicate', 'redirect'];
    const contractOk = data && keys.every((k) => k in data) && data.ok === true && data.duplicate === false;

    let d1Ok = null, d1Detail = '';
    if (MODE !== 'live') {
      const rows = d1(`SELECT utm_source, utm_medium, utm_campaign, utm_content, utm_term, first_query, first_url, landing_url, gclid, fbc, consent_text, contactable FROM leads WHERE lead_uuid='${data?.leadUuid}'`);
      const r = rows[0] || {};
      const need = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'first_query', 'first_url', 'landing_url', 'gclid', 'fbc', 'consent_text'];
      const empty = need.filter((k) => !r[k]);
      d1Ok = rows.length === 1 && empty.length === 0 && r.contactable === 1;
      d1Detail = empty.length ? 'empty: ' + empty.join(',') : rows.length !== 1 ? 'no row' : '';
    }

    let capiOk = null, capiDetail = '';
    if (stubAvailable) {
      const st = await stub('/__state');
      const ev = st.capi.find((e) => e.event_id === data?.eventId);
      const srcOk = ev && TAG_PARAMS.every((p) => String(ev.event_source_url || '').includes(p));
      const ud = ev?.user_data || {};
      const udOk = ['em', 'ph', 'fn', 'ln', 'st', 'external_id'].every((k) => ud[k]) && ud.client_ip_address !== undefined || false;
      const udNeeded = ['em', 'ph', 'fn', 'ln', 'st', 'external_id'].filter((k) => !ud[k]);
      const valOk = ev && ev.custom_data && 'value' in ev.custom_data && ev.custom_data.currency;
      capiOk = !!(ev && srcOk && udNeeded.length === 0 && valOk);
      capiDetail = !ev ? 'no CAPI event with server eventId' : !srcOk ? `event_source_url=${ev.event_source_url}` : udNeeded.length ? 'user_data missing: ' + udNeeded.join(',') : !valOk ? 'no value/currency' : '';
      if (BREAK === 'eventid') {
        const attacker = st.capi.find((e) => e.event_id === 'ATTACKER-SUPPLIED-ID');
        if (attacker) { capiOk = false; capiDetail = 'CAPI used the ATTACKER event id'; }
      }
    }
    const all = [cookieCarriesAll, renderedOk, contractOk, d1Ok !== false, capiOk !== false].every(Boolean);
    gate('G2 tagged walk: cookie → rendered fields → JSON contract → D1 → CAPI payload', all,
      [!cookieCarriesAll && 'first-touch cookie missing params', !renderedOk && `rendered firstQuery="${renderedFirstQuery}"`, !contractOk && `contract=${JSON.stringify(data)}`, d1Ok === false && `D1: ${d1Detail}`, capiOk === false && `CAPI: ${capiDetail}`].filter(Boolean).join(' | '));
  }

  // ============ GATE 3 — one submit → exactly one server event with the server's id ============
  if (stubAvailable) {
    const st = await stub('/__state');
    const mine = st.capi.filter((e) => e.event_name === 'Lead');
    const withId = mine.filter((e) => e.event_id === lead1?.eventId);
    gate('G3 one submit → exactly one Lead event, id = server eventId', mine.length === 1 && withId.length === 1, `Lead events: ${mine.length}`);
  } else {
    gate('G3 one deduped event pair', null, 'needs stub (local) or Events Manager (live) — NOT covered here');
  }

  // ============ GATE 4 — same email+phone again → duplicate:true, still stored, no second event ============
  {
    const before = stubAvailable ? (await stub('/__state')).capi.filter((e) => e.event_name === 'Lead').length : 0;
    const j2 = jar(); // new browser: new lead_uuid — dedup must catch by email/phone
    await get('/', j2);
    const payload = {
      first_name: 'Smoke', last_name: 'Test',
      email: BREAK === 'dedup' ? `different-${ts}@example.com` : EMAIL,
      phone: BREAK === 'dedup' ? '555' + String(ts + 1111111).slice(-7) : PHONE,
      businessName: 'Smoke Spa Co', state: 'MI', isOwner: 'yes', monthlyVolume: '5-10',
      terms: 'on', consentGiven: 'true', consentText: 'x', consentVersion: 'v', consentUrl: BASE,
    };
    const { data } = await postLead(payload, j2);
    const after = stubAvailable ? (await stub('/__state')).capi.filter((e) => e.event_name === 'Lead').length : 0;
    let stored = null;
    if (MODE !== 'live') {
      const rows = d1(`SELECT conversion_status FROM leads WHERE lead_uuid='${data?.leadUuid}'`);
      stored = rows.length === 1;
    }
    const ok = data?.duplicate === true && (!stubAvailable || after === before) && stored !== false;
    gate('G4 duplicate → duplicate:true, no 2nd CAPI event, lead STILL stored', ok,
      `duplicate=${data?.duplicate} capiBefore=${before} capiAfter=${after} stored=${stored}`);
  }

  // ============ GATE 4b — C4: a prior FAILED conversion allows a retry ============
  if (stubAvailable && MODE !== 'live') {
    const em2 = `retry-${ts}@example.com`;
    const ph2 = '444' + String(ts).slice(-7);
    const mk = (j) => ({ first_name: 'Retry', last_name: 'Case', email: em2, phone: ph2, businessName: 'X Spa', state: 'MI', isOwner: 'yes', monthlyVolume: '5-10', terms: 'on', consentGiven: 'true', consentText: 'x', consentVersion: 'v', consentUrl: BASE });
    await stub('/__fail', { capi: 500 });
    const jA = jar(); await get('/', jA);
    const r1 = await postLead(mk(jA), jA);
    await stub('/__fail', {});
    const s1 = d1(`SELECT conversion_status, capi_status FROM leads WHERE lead_uuid='${r1.data?.leadUuid}'`)[0] || {};
    const alerts1 = (await stub('/__state')).alerts.filter((a) => a.body?.alert === 'CAPI_LEAD_FAILED').length;
    const jB = jar(); await get('/', jB);
    const r2 = await postLead(mk(jB), jB);
    const s2 = d1(`SELECT conversion_status FROM leads WHERE lead_uuid='${r2.data?.leadUuid}'`)[0] || {};
    const ok = r1.data?.duplicate === false && s1.conversion_status === 'failed' && alerts1 >= 1 &&
      r2.data?.duplicate === false && s2.conversion_status === 'ok';
    gate('G4b failed conversion → alert fired + retry allowed, retry converts (C4/C6)', ok,
      `first=${s1.conversion_status}/${s1.capi_status} alerts=${alerts1} retryDup=${r2.data?.duplicate} retry=${s2.conversion_status}`);
  }

  // ============ GATE 5 — thank-you reload fires nothing ============
  if (stubAvailable) {
    const before = (await stub('/__state')).capi.length;
    await get('/confirmed', j1);
    if (BREAK === 'reload') {
      // reintroduce the defect class: an event fired on thank-you load
      await fetch(`${STUB}/capi/1200252438858536/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [{ event_name: 'Lead', event_id: 'reload-ghost' }] }) });
    }
    const after = (await stub('/__state')).capi.length;
    gate('G5 /confirmed reload → no events', after === before, `capi ${before}→${after}`);
  } else {
    gate('G5 thank-you reload fires nothing', null, 'needs stub or a browser Network tab — NOT covered here');
  }

  // ============ GATE 6 — record present in D1 AND GHL AND the sheet ============
  {
    let d1Ok = null, ghlOk = null, sheetOk = null;
    if (MODE !== 'live') {
      const rows = d1(`SELECT ghl_contact_id, ghl_status, sheet_status, capi_status, conversion_status FROM leads WHERE lead_uuid='${lead1?.leadUuid}'`);
      const r = rows[0] || {};
      d1Ok = rows.length === 1 && r.conversion_status === 'ok';
      if (stubAvailable) {
        const st = await stub('/__state');
        ghlOk = st.ghl.some((g) => g.body?.email === EMAIL) && r.ghl_status === 'ok' && !!r.ghl_contact_id;
        sheetOk = st.sheetRows.some((row) => row[1] === lead1?.leadUuid) && String(r.sheet_status || '').startsWith('ok');
        if (BREAK === 'ghl') {
          const ghlAlerts = st.alerts.filter((a) => a.body?.alert === 'GHL_UPSERT_FAILED').length;
          console.log(`        [BREAK=ghl] D1 ghl_status=${r.ghl_status} · GHL_UPSERT_FAILED alerts recorded=${ghlAlerts}`);
        }
      }
    }
    const ok = d1Ok !== false && ghlOk !== false && sheetOk !== false && (d1Ok || ghlOk || sheetOk) !== null;
    gate('G6 lead in D1 + GHL + sheet (with status columns ok)', ok, `d1=${d1Ok} ghl=${ghlOk} sheet=${sheetOk}`);
  }

  // ============ GATE 7 — stage progression: one valued event per stage, dedup on repeat ============
  if (MODE !== 'live') {
    const secret = process.env.STAGE_WEBHOOK_SECRET || 'local-stage-secret';
    const fire = async (event, value) => {
      const res = await rfetch(BASE + '/api/lead-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ leadUuid: lead1?.leadUuid, event, ...(value ? { value } : {}) }),
      });
      return { status: res.status, data: await res.json() };
    };
    const q = await fire('qualified');
    const s = await fire('appointment');
    const sh = await fire('showed');
    const badPurchase = await fire('sold'); // no value → must 400
    const p = await fire('sold', 8450);
    const repeat = await fire('appointment');
    if (BREAK === 'stage' && stubAvailable) {
      // reintroduce the defect class: a server that double-sends a stage event
      await fetch(`${STUB}/capi/1200252438858536/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [{ event_name: 'QualifiedLead', event_id: 'stage-double-fire', user_data: { em: ['x'] }, custom_data: { value: 75 } }] }) });
    }
    let stubEventsOk = null;
    if (stubAvailable) {
      const st = await stub('/__state');
      const names = ['QualifiedLead', 'Schedule', 'Showed', 'Purchase'];
      const counts = names.map((n) => st.capi.filter((e) => e.event_name === n && e.user_data?.em).length);
      const values = names.map((n) => st.capi.find((e) => e.event_name === n)?.custom_data?.value);
      stubEventsOk = counts.every((c) => c === 1) && values[3] === 8450 && values.every((v) => typeof v === 'number' && v > 0);
    }
    const ok = [q, s, sh, p].every((r) => r.status === 200 && r.data?.ok && r.data?.sent) &&
      badPurchase.status === 400 && repeat.data?.duplicate === true && stubEventsOk !== false;
    gate('G7 stages fire once each w/ values; Purchase needs real value; repeat = no-op', ok,
      `q=${q.status} sched=${s.status} showed=${sh.status} noValPurchase=${badPurchase.status} purchase=${p.status} repeatDup=${repeat.data?.duplicate} stub=${stubEventsOk}`);
  } else {
    gate('G7 stage progression', null, 'live mode: run one stage by hand per DEPLOY runbook — NOT covered here');
  }

  // ============ GATE 8 — repo hygiene ============
  {
    // This file legitimately names the forbidden strings it hunts, so it
    // builds them at runtime and excludes itself from the scan.
    const TEC = ['TEST', 'EVENT', 'CODE'].join('_');
    const SELF = 'scripts/smoke.mjs';
    const redteamFile = 'scripts/.redteam-hygiene.tmp.ts';
    if (BREAK === 'hygiene') writeFileSync(redteamFile, `export const META_${TEC} = "TEST12345";\n`);
    let bad = [];
    try {
      const grep = (pattern, what, allow) => {
        try {
          const out = execFileSync('git', ['grep', '-nE', '-e', pattern, '--', 'src', 'scripts', 'wrangler.toml', 'workers', `:(exclude)${SELF}`], { encoding: 'utf8' });
          const hits = out.trim().split('\n').filter((l) => l && !(allow && allow.test(l)));
          if (hits.length) bad.push(`${what}:\n${hits.slice(0, 5).join('\n')}`);
        } catch { /* exit 1 = no match = good */ }
      };
      // untracked-but-present files count too (a defect on disk is a defect)
      const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
      for (const f of untracked) {
        if (f === SELF) continue;
        try {
          const content = execFileSync('cat', [f], { encoding: 'utf8' });
          if (new RegExp(TEC).test(content)) bad.push(`${TEC} in untracked ${f}`);
        } catch {}
      }
      grep(TEC, 'test event code committed');
      grep('pit-[A-Za-z0-9]{16,}', 'GHL PIT key literal');
      grep('ops_[A-Za-z0-9]{16,}', 'GHL ops key literal');
      grep('AKIA[0-9A-Z]{16}', 'AWS key literal');
      // a real PEM, not the marker-stripping regex in lead.ts
      grep('BEGIN( RSA)? PRIVATE KEY', 'private key committed', /\.replace\(/);
      grep('xox[baprs]-[A-Za-z0-9-]{10,}', 'Slack token literal');
      const priv = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => f.endsWith('.private.json'));
      if (priv.length) bad.push('*.private.json tracked: ' + priv.join(','));
    } finally {
      if (BREAK === 'hygiene') rmSync(redteamFile, { force: true });
    }
    gate('G8 no test event code, no *.private.json, no secret-shaped literals', bad.length === 0, bad.join(' | '));
  }

  console.log('');
  if (failures > 0) {
    console.log(`\x1b[31mSMOKE FAILED — ${failures} red gate(s)\x1b[0m\n`);
    process.exit(1);
  }
  const skipped = results.filter((r) => r.ok === null).length;
  console.log(`\x1b[32mSMOKE PASSED\x1b[0m${skipped ? ` (${skipped} gate(s) SKIPPED and said so)` : ''}\n`);
}

main().catch((e) => {
  console.error('SMOKE CRASHED:', e);
  process.exit(1);
});
