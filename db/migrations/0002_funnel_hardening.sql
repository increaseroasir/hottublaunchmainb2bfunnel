-- 0002_funnel_hardening.sql
-- Lane C: structured qualification fields, first/last-touch attribution,
-- consent record (C10), contactable flag (C11), per-integration status
-- columns (C6), conversion status for dedup/retry (C3/C4), stage events
-- table with (lead_uuid, event_name) dedup (C13/C14), phone dedup index (C3).

-- structured qualification (B2B checklist: answers as structured fields, not free text)
ALTER TABLE leads ADD COLUMN business_name TEXT;
ALTER TABLE leads ADD COLUMN state TEXT;
ALTER TABLE leads ADD COLUMN is_owner TEXT;
ALTER TABLE leads ADD COLUMN monthly_volume TEXT;
ALTER TABLE leads ADD COLUMN role TEXT;

-- attribution as captured by the middleware cookies
ALTER TABLE leads ADD COLUMN first_url TEXT;
ALTER TABLE leads ADD COLUMN first_query TEXT;
ALTER TABLE leads ADD COLUMN last_url TEXT;
ALTER TABLE leads ADD COLUMN last_query TEXT;
ALTER TABLE leads ADD COLUMN first_seen_at TEXT;
ALTER TABLE leads ADD COLUMN gclid TEXT;

-- consent record (C10) — the exact rendered text, not a boolean
ALTER TABLE leads ADD COLUMN consent_given INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN consent_text TEXT;
ALTER TABLE leads ADD COLUMN consent_version TEXT;
ALTER TABLE leads ADD COLUMN consent_url TEXT;
ALTER TABLE leads ADD COLUMN consent_at TEXT;

-- uncontactable-by-automation flag (C11): true only when consent captured
ALTER TABLE leads ADD COLUMN contactable INTEGER NOT NULL DEFAULT 0;

-- per-integration statuses (C6): every failure lands in a column, never only a console line
ALTER TABLE leads ADD COLUMN conversion_status TEXT; -- 'ok' | 'failed' | 'suppressed' | 'skipped'
ALTER TABLE leads ADD COLUMN d1_status TEXT;
ALTER TABLE leads ADD COLUMN ghl_status TEXT;
ALTER TABLE leads ADD COLUMN capi_status TEXT;
ALTER TABLE leads ADD COLUMN sheet_status TEXT;

ALTER TABLE leads ADD COLUMN submit_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN updated_at TEXT;

-- dedup lookups (C3): same email OR same last-10 phone digits, 24h window
CREATE INDEX IF NOT EXISTS idx_leads_phone10 ON leads (substr(phone, -10));
CREATE INDEX IF NOT EXISTS idx_leads_email_lower ON leads (lower(email));

-- stage push-back events (C13), deduped on (lead_uuid, event_name) (C14)
CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_uuid TEXT NOT NULL,
  event_name TEXT NOT NULL, -- QualifiedLead | Schedule | Showed | Purchase
  event_id TEXT NOT NULL,   -- CAPI event_id; a failed send retries under the SAME id
  value REAL,
  currency TEXT,
  capi_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'sent' | 'failed'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  UNIQUE (lead_uuid, event_name)
);

CREATE INDEX IF NOT EXISTS idx_lead_events_lead ON lead_events(lead_uuid);
