CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_uuid TEXT NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT,
  email TEXT NOT NULL,
  fbp TEXT,
  fbc TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  utm_term TEXT,
  landing_url TEXT,
  quiz_answers TEXT,
  ip TEXT,
  user_agent TEXT,
  ghl_contact_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_lead_uuid ON leads(lead_uuid);
CREATE INDEX IF NOT EXISTS idx_leads_event_id ON leads(event_id);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);