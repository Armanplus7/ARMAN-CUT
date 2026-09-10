CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  name TEXT,
  phone TEXT,
  jy INTEGER NOT NULL,
  jm INTEGER NOT NULL,
  jd INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  UNIQUE(jy, jm, jd, hour, minute)
);
