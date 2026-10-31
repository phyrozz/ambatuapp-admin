-- Production schema preparation; verify the destination independently. API access is intentionally closed.
BEGIN;
CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

CREATE TABLE app.migration_runs (
  id text PRIMARY KEY,
  source_project text NOT NULL,
  source_count integer NOT NULL,
  source_fingerprint text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app.migration_documents (
  source_path text PRIMARY KEY,
  destination text NOT NULL,
  destination_key jsonb NOT NULL
);

-- Profiles are optional: a Cognito account can own content before creating one.
-- Player and Studio pools are distinct; IDs must never be linked to auth.users.
CREATE TABLE app.profile_avatars (
  id text PRIMARY KEY,
  name text,
  image_key text,
  content_type text,
  created_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.player_profiles (
  id text PRIMARY KEY,
  username text,
  username_lower text,
  birth_date date,
  bio text,
  avatar_type text,
  avatar_id text,
  avatar_key text,
  email_search_hash text,
  created_at timestamptz,
  updated_at timestamptz,
  last_active_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'
);
-- Claims remain authoritative during the transition. Do not silently rename duplicates.
CREATE INDEX player_username_prefix ON app.player_profiles (username_lower text_pattern_ops, id);
CREATE INDEX player_email_search ON app.player_profiles (email_search_hash, id) WHERE email_search_hash IS NOT NULL;
CREATE INDEX player_activity ON app.player_profiles (last_active_at DESC, id);
CREATE INDEX player_avatar ON app.player_profiles (avatar_id) WHERE avatar_id IS NOT NULL;
CREATE TABLE app.username_claims (
  username_lower text PRIMARY KEY,
  player_id text NOT NULL,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX username_claim_owner ON app.username_claims (player_id);
CREATE TABLE app.avatar_moderation (
  player_id text PRIMARY KEY,
  status text,
  image_key text,
  username text,
  reviewed_at timestamptz,
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.follows (
  follower_id text NOT NULL,
  followed_id text NOT NULL,
  created_at timestamptz,
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
CREATE INDEX follow_incoming ON app.follows (followed_id, follower_id);
-- One row per viewer preserves independent pins and incoming/outgoing states.
-- The API must update both reciprocal rows in one transaction.
CREATE TABLE app.friendships (
  player_id text NOT NULL,
  other_player_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('incoming', 'outgoing', 'accepted')),
  pinned boolean NOT NULL DEFAULT false,
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (player_id, other_player_id),
  CHECK (player_id <> other_player_id)
);
CREATE INDEX friend_filtered_list ON app.friendships (player_id, state, other_player_id);
CREATE INDEX friend_pinned_list ON app.friendships (player_id, other_player_id) WHERE pinned AND state = 'accepted';

-- Firestore IDs can collide across collections, so the key includes kind.
CREATE TABLE app.content (
  kind text NOT NULL CHECK (kind IN ('character', 'lore', 'video', 'sound')),
  id text NOT NULL,
  status text CHECK (status IN ('Draft', 'Published')),
  source text,
  uploader_id text,
  created_by text,
  created_at timestamptz,
  updated_at timestamptz,
  upvotes bigint NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
  downvotes bigint NOT NULL DEFAULT 0 CHECK (downvotes >= 0),
  comment_count bigint NOT NULL DEFAULT 0 CHECK (comment_count >= 0),
  view_count bigint NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (kind, id)
);
CREATE INDEX content_fresh_feed ON app.content (kind, status, created_at DESC NULLS LAST, id);
CREATE INDEX content_popular_feed ON app.content (kind, status, upvotes DESC, comment_count DESC, created_at DESC NULLS LAST, id);
CREATE INDEX content_creator_feed ON app.content (uploader_id, kind, created_at DESC NULLS LAST, id);
CREATE INDEX content_studio_owner ON app.content (created_by, kind, updated_at DESC NULLS LAST, id);
CREATE TABLE app.characters (
  kind text NOT NULL DEFAULT 'character' CHECK (kind = 'character'),
  id text PRIMARY KEY,
  name text,
  title text,
  bio text,
  image_key text,
  legacy_image text,
  tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tags) = 'array'),
  FOREIGN KEY (kind, id) REFERENCES app.content (kind, id) ON DELETE CASCADE
);
CREATE TABLE app.lores (
  kind text NOT NULL DEFAULT 'lore' CHECK (kind = 'lore'),
  id text PRIMARY KEY,
  title text,
  body text,
  tags jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(tags) = 'array'),
  image_keys jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(image_keys) = 'array'),
  translations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(translations) = 'array'),
  FOREIGN KEY (kind, id) REFERENCES app.content (kind, id) ON DELETE CASCADE
);
CREATE TABLE app.videos (
  kind text NOT NULL DEFAULT 'video' CHECK (kind = 'video'),
  id text PRIMARY KEY,
  title text,
  description text,
  video_key text,
  thumbnail_key text,
  uploader_name text,
  uploader_email text,
  FOREIGN KEY (kind, id) REFERENCES app.content (kind, id) ON DELETE CASCADE
);
CREATE TABLE app.sounds (
  kind text NOT NULL DEFAULT 'sound' CHECK (kind = 'sound'),
  id text PRIMARY KEY,
  name text,
  category text,
  color integer,
  sound_key text,
  play_count bigint NOT NULL DEFAULT 0 CHECK (play_count >= 0),
  listener_count bigint NOT NULL DEFAULT 0 CHECK (listener_count >= 0),
  FOREIGN KEY (kind, id) REFERENCES app.content (kind, id) ON DELETE CASCADE
);
CREATE TABLE app.comments (
  content_kind text NOT NULL,
  content_id text NOT NULL,
  id text NOT NULL,
  parent_id text,
  body text,
  author_id text,
  author_name text,
  author_email text,
  created_at timestamptz,
  upvotes bigint NOT NULL DEFAULT 0 CHECK (upvotes >= 0),
  downvotes bigint NOT NULL DEFAULT 0 CHECK (downvotes >= 0),
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (content_kind, content_id, id),
  FOREIGN KEY (content_kind, content_id) REFERENCES app.content (kind, id) ON DELETE CASCADE,
  FOREIGN KEY (content_kind, content_id, parent_id) REFERENCES app.comments (content_kind, content_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX comment_feed ON app.comments (content_kind, content_id, created_at DESC NULLS LAST, id DESC);
CREATE INDEX comment_replies ON app.comments (content_kind, content_id, parent_id, created_at, id);
-- voter_key preserves historical raw IDs, including the video 'user:' prefix.
CREATE TABLE app.content_votes (
  content_kind text NOT NULL,
  content_id text NOT NULL,
  voter_key text NOT NULL,
  value smallint NOT NULL CHECK (value IN (-1, 0, 1)),
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (content_kind, content_id, voter_key),
  FOREIGN KEY (content_kind, content_id) REFERENCES app.content (kind, id) ON DELETE CASCADE
);
CREATE TABLE app.comment_votes (
  content_kind text NOT NULL,
  content_id text NOT NULL,
  comment_id text NOT NULL,
  voter_key text NOT NULL,
  value smallint NOT NULL CHECK (value IN (-1, 0, 1)),
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (content_kind, content_id, comment_id, voter_key),
  FOREIGN KEY (content_kind, content_id, comment_id) REFERENCES app.comments (content_kind, content_id, id) ON DELETE CASCADE
);
CREATE TABLE app.content_visitors (
  content_kind text NOT NULL,
  content_id text NOT NULL,
  event text NOT NULL CHECK (event IN ('view', 'listen')),
  viewer_hash text NOT NULL,
  first_seen_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (content_kind, content_id, event, viewer_hash),
  FOREIGN KEY (content_kind, content_id) REFERENCES app.content (kind, id) ON DELETE CASCADE
);
-- Leaderboard parent documents are not required to exist in Firestore.
CREATE TABLE app.leaderboard_entries (
  game_id text NOT NULL,
  player_id text NOT NULL,
  player_label text,
  score bigint NOT NULL CHECK (score >= 0),
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (game_id, player_id)
);
CREATE INDEX leaderboard_ranking ON app.leaderboard_entries (game_id, score DESC, updated_at ASC NULLS LAST, player_id);
CREATE TABLE app.public_api_rate_limits (
  player_hash text PRIMARY KEY,
  rates jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(rates) = 'object'),
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE app.studio_modules (
  id text PRIMARY KEY,
  message_key text,
  href text,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.studio_role_types (
  id text PRIMARY KEY,
  message_key text,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.studio_roles (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  protected boolean NOT NULL DEFAULT false,
  imported_user_count bigint,
  created_at timestamptz,
  updated_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE app.studio_role_permissions (
  role_id text NOT NULL REFERENCES app.studio_roles (id) ON DELETE CASCADE,
  module_id text NOT NULL REFERENCES app.studio_modules (id),
  action_id text NOT NULL REFERENCES app.studio_role_types (id),
  PRIMARY KEY (role_id, module_id, action_id)
);
CREATE TABLE app.studio_users (
  id text PRIMARY KEY,
  first_name text,
  last_name text,
  display_name text,
  country text,
  bio text,
  email text,
  username text,
  role_id text REFERENCES app.studio_roles (id),
  enabled boolean NOT NULL DEFAULT false,
  registration_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz,
  updated_at timestamptz,
  seeded_at timestamptz,
  extra jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX studio_user_role ON app.studio_users (role_id, id) WHERE enabled;
CREATE TABLE app.studio_settings (
  id text PRIMARY KEY,
  settings jsonb NOT NULL
);

-- Keep source records whose content parent was deleted, without exposing them in the app.
CREATE TABLE app.firestore_orphan_documents (
  source_path text PRIMARY KEY,
  document jsonb NOT NULL,
  reason text NOT NULL
);

-- Keep app tables private, including on projects with permissive default grants.
DO $security$
DECLARE t record; role_name text;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('REVOKE ALL ON TABLE app.%I FROM PUBLIC', t.tablename);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA app FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA app FROM %I', role_name);
    END IF;
  END LOOP;
END
$security$;
COMMIT;
