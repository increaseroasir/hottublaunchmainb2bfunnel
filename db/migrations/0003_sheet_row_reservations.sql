-- Reserve explicit Sheet rows atomically across concurrent Worker requests.
CREATE TABLE IF NOT EXISTS sheet_row_reservations (
  sheet_id TEXT NOT NULL,
  lead_uuid TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK (row_number >= 2),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (sheet_id, lead_uuid),
  UNIQUE (sheet_id, row_number)
);
