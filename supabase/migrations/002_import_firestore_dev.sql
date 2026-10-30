-- DEV ONLY: imports an unmodified ambatuapp-dev staging export into empty app tables.
-- Run after 001_app_schema.sql, as postgres. The entire import is atomic.
BEGIN;
CREATE OR REPLACE FUNCTION migration_staging.firestore_value(v jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
DECLARE result jsonb; entry record;
BEGIN
  IF jsonb_typeof(v) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(v)) <> 1 THEN
    RAISE EXCEPTION 'Invalid typed Firestore value';
  END IF;
  IF v ? 'nullValue' THEN RETURN 'null'::jsonb;
  ELSIF v ? 'stringValue' THEN RETURN v->'stringValue';
  ELSIF v ? 'booleanValue' THEN RETURN v->'booleanValue';
  ELSIF v ? 'integerValue' THEN RETURN to_jsonb((v->>'integerValue')::numeric);
  ELSIF v ? 'doubleValue' THEN RETURN v->'doubleValue';
  ELSIF v ? 'timestampValue' THEN RETURN v->'timestampValue';
  ELSIF v ? 'referenceValue' THEN RETURN v->'referenceValue';
  ELSIF v ? 'bytesValue' THEN RETURN v->'bytesValue';
  ELSIF v ? 'geoPointValue' THEN RETURN v->'geoPointValue';
  ELSIF v ? 'arrayValue' THEN
    SELECT coalesce(jsonb_agg(migration_staging.firestore_value(value) ORDER BY ord), '[]'::jsonb)
      INTO result FROM jsonb_array_elements(coalesce(v #> '{arrayValue,values}', '[]')) WITH ORDINALITY a(value, ord);
    RETURN result;
  ELSIF v ? 'mapValue' THEN
    result := '{}'::jsonb;
    FOR entry IN SELECT * FROM jsonb_each(coalesce(v #> '{mapValue,fields}', '{}')) LOOP
      result := result || jsonb_build_object(entry.key, migration_staging.firestore_value(entry.value));
    END LOOP;
    RETURN result;
  END IF;
  RAISE EXCEPTION 'Unsupported Firestore value type';
END
$fn$;
REVOKE ALL ON FUNCTION migration_staging.firestore_value(jsonb) FROM PUBLIC;

DO $import$
DECLARE source_count integer; fingerprint text; previous app.migration_runs%ROWTYPE; t record;
BEGIN
  LOCK TABLE migration_staging.firestore_documents IN SHARE MODE;
  SELECT count(*), md5(coalesce(string_agg(md5(path || document::text), '' ORDER BY path), ''))
    INTO source_count, fingerprint FROM migration_staging.firestore_documents;
  IF source_count = 0 THEN RAISE EXCEPTION 'Staging is empty'; END IF;
  IF EXISTS (SELECT 1 FROM migration_staging.firestore_documents
    WHERE document->>'name' IS DISTINCT FROM 'projects/ambatuapp-dev/databases/(default)/documents/' || path
      OR document->>'createTime' IS NULL) THEN
    RAISE EXCEPTION 'Staging is not an ambatuapp-dev default-database export';
  END IF;
  -- Do not overwrite a populated app schema, or edits made after the first import.
  SELECT * INTO previous FROM app.migration_runs WHERE id = 'firestore-dev-v1';
  IF FOUND THEN
    IF previous.source_fingerprint <> fingerprint OR previous.source_count <> source_count THEN
      RAISE EXCEPTION 'A different dataset was already imported; use a separate dev database for a new rehearsal';
    END IF;
    RAISE NOTICE 'This dataset was already imported; no rows changed';
    RETURN;
  END IF;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    DECLARE occupied boolean;
    BEGIN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM app.%I)', t.tablename) INTO occupied;
      IF occupied THEN RAISE EXCEPTION 'App schema must be empty before first import'; END IF;
    END;
  END LOOP;

  CREATE TEMP TABLE fs_source ON COMMIT DROP AS
  SELECT path, string_to_array(path, '/') AS parts,
    migration_staging.firestore_value(jsonb_build_object('mapValue', jsonb_build_object('fields', coalesce(document->'fields', '{}')))) AS d,
    CASE split_part(path, '/', 1) WHEN 'characters' THEN 'character' WHEN 'lores' THEN 'lore'
      WHEN 'videos' THEN 'video' WHEN 'soundboardSounds' THEN 'sound' END AS kind,
    CASE
      WHEN path ~ '^(characters|lores|videos|soundboardSounds)/[^/]+$' THEN 'content'
      WHEN path ~ '^(lores|videos)/[^/]+/comments/[^/]+$' THEN 'comments'
      WHEN path ~ '^(lores|videos)/[^/]+/votes/[^/]+$' THEN 'content_votes'
      WHEN path ~ '^(lores|videos)/[^/]+/comments/[^/]+/votes/[^/]+$' THEN 'comment_votes'
      WHEN path ~ '^(characters|lores)/[^/]+/creatorViews/[^/]+$' THEN 'content_visitors'
      WHEN path ~ '^soundboardSounds/[^/]+/creatorListeners/[^/]+$' THEN 'content_visitors'
      WHEN path ~ '^playerProfiles/[^/]+$' THEN 'player_profiles'
      WHEN path ~ '^playerProfiles/[^/]+/(following|followers)/[^/]+$' THEN 'follows'
      WHEN path ~ '^playerProfiles/[^/]+/friends/[^/]+$' THEN 'friendships'
      WHEN path ~ '^leaderboards/[^/]+/entries/[^/]+$' THEN 'leaderboard_entries'
      WHEN path ~ '^playerUsernameClaims/[^/]+$' THEN 'username_claims'
      WHEN path ~ '^profileAvatars/[^/]+$' THEN 'profile_avatars'
      WHEN path ~ '^profileAvatarModeration/[^/]+$' THEN 'avatar_moderation'
      WHEN path ~ '^publicApiRateLimits/[^/]+$' THEN 'public_api_rate_limits'
      WHEN path ~ '^studioModules/[^/]+$' THEN 'studio_modules'
      WHEN path ~ '^studioRoleTypes/[^/]+$' THEN 'studio_role_types'
      WHEN path ~ '^studioRoles/[^/]+$' THEN 'studio_roles'
      WHEN path ~ '^studioUsers/[^/]+$' THEN 'studio_users'
      WHEN path ~ '^studioSettings/[^/]+$' THEN 'studio_settings'
    END AS destination
  FROM migration_staging.firestore_documents;
  IF EXISTS (SELECT 1 FROM fs_source WHERE destination IS NULL) THEN
    RAISE EXCEPTION 'Unmapped document paths exist; extend the schema before importing';
  END IF;

  INSERT INTO app.profile_avatars
  SELECT parts[2], d->>'name', d->>'imageKey', d->>'contentType', (d->>'createdAt')::timestamptz,
    d - ARRAY['name','imageKey','contentType','createdAt'] FROM fs_source WHERE destination = 'profile_avatars';
  INSERT INTO app.player_profiles
  SELECT parts[2], d->>'username', d->>'usernameLower', (d->>'birthDate')::date, d->>'bio',
    d->>'avatarType', d->>'avatarId', d->>'avatarKey', d->>'emailSearchHash',
    (d->>'createdAt')::timestamptz, (d->>'updatedAt')::timestamptz, (d->>'lastActiveAt')::timestamptz,
    d - ARRAY['username','usernameLower','birthDate','bio','avatarType','avatarId','avatarKey','emailSearchHash','createdAt','updatedAt','lastActiveAt']
    FROM fs_source WHERE destination = 'player_profiles';
  INSERT INTO app.username_claims
  SELECT parts[2], d->>'playerId', d - 'playerId' FROM fs_source WHERE destination = 'username_claims';
  INSERT INTO app.avatar_moderation
  SELECT parts[2], d->>'status', d->>'imageKey', d->>'username', (d->>'reviewedAt')::timestamptz,
    (d->>'updatedAt')::timestamptz, d - ARRAY['status','imageKey','username','reviewedAt','updatedAt']
    FROM fs_source WHERE destination = 'avatar_moderation';

  -- Both reciprocal follow documents must be present and equal, never guessed.
  IF EXISTS (SELECT 1 FROM fs_source a WHERE a.destination = 'follows' AND NOT EXISTS (
    SELECT 1 FROM fs_source b WHERE b.path = 'playerProfiles/' || a.parts[4] || '/' ||
      CASE a.parts[3] WHEN 'following' THEN 'followers' ELSE 'following' END || '/' || a.parts[2] AND b.d = a.d
  )) THEN RAISE EXCEPTION 'Follow mirrors are missing or disagree; reconcile staging before importing'; END IF;
  INSERT INTO app.follows
  SELECT parts[2], parts[4], (d->>'createdAt')::timestamptz FROM fs_source
    WHERE destination = 'follows' AND parts[3] = 'following';
  INSERT INTO app.friendships
  SELECT parts[2], parts[4], d->>'state', coalesce((d->>'pinned')::boolean, false),
    (d->>'updatedAt')::timestamptz, d - ARRAY['state','pinned','updatedAt']
    FROM fs_source WHERE destination = 'friendships';
  IF EXISTS (SELECT 1 FROM app.friendships a LEFT JOIN app.friendships b
      ON b.player_id = a.other_player_id AND b.other_player_id = a.player_id
      WHERE b.state IS DISTINCT FROM CASE a.state WHEN 'incoming' THEN 'outgoing' WHEN 'outgoing' THEN 'incoming' ELSE 'accepted' END) THEN
    RAISE EXCEPTION 'Friendship mirrors are missing or disagree';
  END IF;

  INSERT INTO app.content
  SELECT kind, parts[2], d->>'status', d->>'source', d->>'uploaderId', d->>'createdBy',
    (d->>'createdAt')::timestamptz, (d->>'updatedAt')::timestamptz,
    coalesce((d->>'upvotes')::bigint,0), coalesce((d->>'downvotes')::bigint,0),
    coalesce((d->>'commentCount')::bigint,0), coalesce((d->>'viewCount')::bigint,0),
    d - ARRAY['status','source','uploaderId','createdBy','createdAt','updatedAt','upvotes','downvotes','commentCount','viewCount']
      - CASE kind
        WHEN 'character' THEN ARRAY['name','title','bio','imageKey','image','tags']
        WHEN 'lore' THEN ARRAY['title','text','tags','imageKeys','translations']
        WHEN 'video' THEN ARRAY['title','description','videoKey','thumbnailKey','uploaderName','uploaderEmail']
        WHEN 'sound' THEN ARRAY['name','category','color','soundKey','playCount','listenerCount'] END
    FROM fs_source WHERE destination = 'content';
  INSERT INTO app.characters (id, name, title, bio, image_key, legacy_image, tags)
  SELECT parts[2], d->>'name', d->>'title', d->>'bio', d->>'imageKey', d->>'image', coalesce(d->'tags','[]')
    FROM fs_source WHERE destination = 'content' AND kind = 'character';
  INSERT INTO app.lores (id, title, body, tags, image_keys, translations)
  SELECT parts[2], d->>'title', d->>'text', coalesce(d->'tags','[]'), coalesce(d->'imageKeys','[]'), coalesce(d->'translations','[]')
    FROM fs_source WHERE destination = 'content' AND kind = 'lore';
  INSERT INTO app.videos (id, title, description, video_key, thumbnail_key, uploader_name, uploader_email)
  SELECT parts[2], d->>'title', d->>'description', d->>'videoKey', d->>'thumbnailKey', d->>'uploaderName', d->>'uploaderEmail'
    FROM fs_source WHERE destination = 'content' AND kind = 'video';
  INSERT INTO app.sounds (id, name, category, color, sound_key, play_count, listener_count)
  SELECT parts[2], d->>'name', d->>'category', (d->>'color')::integer, d->>'soundKey',
    coalesce((d->>'playCount')::bigint,0), coalesce((d->>'listenerCount')::bigint,0)
    FROM fs_source WHERE destination = 'content' AND kind = 'sound';
  INSERT INTO app.comments
  SELECT kind, parts[2], parts[4], d->>'parentId', d->>'text', d->>'authorId', d->>'author', d->>'authorEmail',
    (d->>'createdAt')::timestamptz, coalesce((d->>'upvotes')::bigint,0), coalesce((d->>'downvotes')::bigint,0),
    d - ARRAY['parentId','text','authorId','author','authorEmail','createdAt','upvotes','downvotes']
    FROM fs_source WHERE destination = 'comments';
  INSERT INTO app.content_votes
  SELECT kind, parts[2], parts[4], (d->>'value')::smallint, (d->>'updatedAt')::timestamptz, d - ARRAY['value','updatedAt']
    FROM fs_source WHERE destination = 'content_votes';
  INSERT INTO app.comment_votes
  SELECT kind, parts[2], parts[4], parts[6], (d->>'value')::smallint, (d->>'updatedAt')::timestamptz, d - ARRAY['value','updatedAt']
    FROM fs_source WHERE destination = 'comment_votes';
  INSERT INTO app.content_visitors
  SELECT kind, parts[2], CASE parts[3] WHEN 'creatorViews' THEN 'view' ELSE 'listen' END, parts[4],
    coalesce(d->>'viewedAt',d->>'listenedAt')::timestamptz, d - ARRAY['viewedAt','listenedAt']
    FROM fs_source WHERE destination = 'content_visitors';
  INSERT INTO app.leaderboard_entries
  SELECT parts[2], parts[4], d->>'player', (d->>'score')::bigint, (d->>'updatedAt')::timestamptz,
    d - ARRAY['player','score','updatedAt'] FROM fs_source WHERE destination = 'leaderboard_entries';
  INSERT INTO app.public_api_rate_limits
  SELECT parts[2], coalesce(d->'rates','{}'), (d->>'updatedAt')::timestamptz, d - ARRAY['rates','updatedAt']
    FROM fs_source WHERE destination = 'public_api_rate_limits';
  INSERT INTO app.studio_modules
  SELECT parts[2], d->>'key', d->>'href', d - ARRAY['key','href'] FROM fs_source WHERE destination = 'studio_modules';
  INSERT INTO app.studio_role_types
  SELECT parts[2], d->>'key', d - 'key' FROM fs_source WHERE destination = 'studio_role_types';
  INSERT INTO app.studio_roles
  SELECT parts[2], d->>'name', d->>'description', coalesce((d->>'protected')::boolean,false),
    (d->>'userCount')::bigint, (d->>'createdAt')::timestamptz, (d->>'updatedAt')::timestamptz,
    d - ARRAY['name','description','protected','userCount','createdAt','updatedAt','permissions']
    FROM fs_source WHERE destination = 'studio_roles';
  INSERT INTO app.studio_role_permissions
  SELECT s.parts[2], permission.key, action.value FROM fs_source s
    CROSS JOIN LATERAL jsonb_each(coalesce(s.d->'permissions','{}')) permission
    CROSS JOIN LATERAL jsonb_array_elements_text(permission.value) action
    WHERE s.destination = 'studio_roles';
  INSERT INTO app.studio_users
  SELECT parts[2], d->>'firstName', d->>'lastName', d->>'displayName', d->>'country', d->>'bio', d->>'email', d->>'username',
    d->>'roleId', coalesce((d->>'enabled')::boolean,false), coalesce((d->>'registrationPending')::boolean,false),
    (d->>'createdAt')::timestamptz, (d->>'updatedAt')::timestamptz, (d->>'seededAt')::timestamptz,
    d - ARRAY['firstName','lastName','displayName','country','bio','email','username','roleId','enabled','registrationPending','createdAt','updatedAt','seededAt']
    FROM fs_source WHERE destination = 'studio_users';
  INSERT INTO app.studio_settings SELECT parts[2], d FROM fs_source WHERE destination = 'studio_settings';

  INSERT INTO app.migration_documents
  SELECT path, destination,
    CASE
      WHEN destination = 'content' THEN jsonb_build_object('kind',kind,'id',parts[2])
      WHEN destination = 'comments' THEN jsonb_build_object('content_kind',kind,'content_id',parts[2],'id',parts[4])
      WHEN destination = 'content_votes' THEN jsonb_build_object('content_kind',kind,'content_id',parts[2],'voter_key',parts[4])
      WHEN destination = 'comment_votes' THEN jsonb_build_object('content_kind',kind,'content_id',parts[2],'comment_id',parts[4],'voter_key',parts[6])
      WHEN destination = 'content_visitors' THEN jsonb_build_object('content_kind',kind,'content_id',parts[2],'event',CASE parts[3] WHEN 'creatorViews' THEN 'view' ELSE 'listen' END,'viewer_hash',parts[4])
      WHEN destination = 'follows' THEN jsonb_build_object('follower_id',CASE parts[3] WHEN 'following' THEN parts[2] ELSE parts[4] END,'followed_id',CASE parts[3] WHEN 'following' THEN parts[4] ELSE parts[2] END)
      WHEN destination = 'friendships' THEN jsonb_build_object('player_id',parts[2],'other_player_id',parts[4])
      WHEN destination = 'leaderboard_entries' THEN jsonb_build_object('game_id',parts[2],'player_id',parts[4])
      WHEN destination = 'username_claims' THEN jsonb_build_object('username_lower',parts[2])
      WHEN destination = 'avatar_moderation' THEN jsonb_build_object('player_id',parts[2])
      WHEN destination = 'public_api_rate_limits' THEN jsonb_build_object('player_hash',parts[2])
      ELSE jsonb_build_object('id',parts[2]) END
    FROM fs_source;
  SET CONSTRAINTS ALL IMMEDIATE;
  INSERT INTO app.migration_runs VALUES ('firestore-dev-v1', 'ambatuapp-dev', source_count, fingerprint, now());
  RAISE NOTICE 'Imported % source documents; follow mirrors share one destination row', source_count;
END
$import$;
COMMIT;
