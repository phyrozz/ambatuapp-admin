BEGIN;
ALTER TABLE app.player_profiles ADD COLUMN IF NOT EXISTS registration_country text;
CREATE INDEX IF NOT EXISTS player_registration_country ON app.player_profiles (registration_country) WHERE registration_country IS NOT NULL;
COMMIT;
