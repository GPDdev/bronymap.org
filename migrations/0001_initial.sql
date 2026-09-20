CREATE TABLE markers (
  id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL,
  precision_km INTEGER NOT NULL CHECK (precision_km IN (10, 25)),
  public_lat REAL NOT NULL,
  public_lng REAL NOT NULL,
  city_label TEXT NOT NULL,
  display_name TEXT,
  contact TEXT,
  delete_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX markers_active ON markers(status, expires_at);
CREATE INDEX markers_cell ON markers(cell_id, status, expires_at);
