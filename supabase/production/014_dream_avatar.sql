BEGIN;
GRANT SELECT (avatar_key) ON app.player_profiles TO ambatu_prod_dream_writer;
CREATE INDEX prod_public_creator_lore ON app.content (uploader_id, (coalesce(created_at,timestamptz '1970-01-01 00:00:00+00')) DESC, (id COLLATE "C") DESC)
  WHERE kind='lore' AND source='revamp' AND status='Published';
COMMIT;
