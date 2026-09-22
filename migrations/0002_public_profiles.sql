ALTER TABLE markers ADD COLUMN profile_public INTEGER NOT NULL DEFAULT 0 CHECK (profile_public IN (0, 1));
