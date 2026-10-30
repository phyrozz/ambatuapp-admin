// Run only against an isolated local Next dev server and local test database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const port = process.env.CONTENT_TEST_PORT;
const base = process.env.CONTENT_TEST_BASE_URL;
const enabled = Boolean(port && base);
const pool = enabled ? new pg.Pool({ host: '127.0.0.1', port: Number(port), user: 'postgres', database: 'postgres' }) : null;
if (enabled && new URL(base).hostname !== '127.0.0.1') throw new Error('Test server must be on loopback');

test('dev content endpoints paginate, filter, protect drafts, and limit database privileges', { skip: !enabled }, async () => {
  const reader = new pg.Client({ host: '127.0.0.1', port: Number(port), user: 'ambatu_dev_content_reader', database: 'postgres' });
  const prefix = 'zz_dev_read_fixture_';
  try {
    await pool.query(`INSERT INTO app.content (kind,id,status,status_missing,created_at,upvotes,comment_count) VALUES
      ('character',$1,'Published',false,'2026-01-01Z',0,0),('character',$2,'Published',false,'2026-01-01Z',0,0),('character',$3,'Draft',false,'2026-01-01Z',0,0),
      ('lore',$1,'Published',false,'2026-01-01Z',2,0),
      ('video',$1,'Published',false,now() - interval '1 day',5,1),('video',$2,'Published',false,now() - interval '2 days',1,1),
      ('video',$4,'Published',false,'2026-01-01Z',100,1),
      ('sound',$1,NULL,true,'2026-01-01Z',0,0),('sound',$2,NULL,false,'2026-01-01Z',0,0)`, [prefix+'a',prefix+'b',prefix+'draft',prefix+'c']);
    await pool.query('INSERT INTO app.characters (id,name) VALUES ($1,\'Same\'),($2,\'Same\'),($3,\'Secret\')', [prefix+'a',prefix+'b',prefix+'draft']);
    await pool.query(`INSERT INTO app.lores (id,title,body,tags,translations) VALUES
      ($1,'Original','Body','["adventure"]','[{"locale":"id","label":"Indonesian","title":"Translated title","text":"Translated text"}]')`, [prefix+'a']);
    await pool.query('INSERT INTO app.videos (id,title) VALUES ($1,\'Video\'),($2,\'Video\'),($3,\'Older popular video\')', [prefix+'a',prefix+'b',prefix+'c']);
    await pool.query("INSERT INTO app.sounds (id,name,category,sound_key) VALUES ($1,'Legacy','Other','soundboard/admin/test.mp3'),($2,'Null','Other','soundboard/admin/test.mp3')", [prefix+'a',prefix+'b']);
    await reader.connect();
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE id=$1", [prefix+'draft'])).rows[0].n, 0);
    assert.equal((await reader.query("SELECT count(*)::int n FROM app.content WHERE kind='sound' AND id=$1", [prefix+'b'])).rows[0].n, 0);
    await assert.rejects(reader.query('SELECT birth_date FROM app.player_profiles'), /permission denied/);
    await assert.rejects(reader.query('SELECT * FROM app.studio_users'), /permission denied/);
    await assert.rejects(reader.query("DELETE FROM app.content WHERE id=$1", [prefix+'a']), /permission denied/);

    async function get(path) {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
      const body = await response.json();
      if (!response.ok) throw new Error(`GET ${path.split('?')[0]} returned ${response.status}`);
      return body;
    }
    async function all(path, key) {
      const ids = []; let cursor = null; let requests = 0;
      do {
        const url = new URL(path, base);
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await get(url.pathname + url.search);
        assert.ok(Array.isArray(response[key]));
        assert.ok(response[key].length <= 1);
        ids.push(...response[key].map(item => item.id));
        cursor = response.nextCursor;
        assert.ok(++requests < 100, 'cursor must terminate');
      } while (cursor);
      return ids;
    }
    const characters = await all('/api/public/characters?limit=1', 'characters');
    assert.equal(new Set(characters).size, characters.length);
    assert.ok(characters.includes(prefix+'a') && characters.includes(prefix+'b'));
    assert.ok(!characters.includes(prefix+'draft'));
    const descending = await all('/api/public/characters?limit=1&sort=nameDesc', 'characters');
    assert.deepEqual(descending, [...characters].reverse());
    const searched = await all('/api/public/characters?limit=1&q=Same', 'characters');
    assert.ok(searched.includes(prefix+'a') && searched.includes(prefix+'b'));
    const sounds = await all('/api/public/sounds?limit=1', 'sounds');
    assert.equal(new Set(sounds).size, sounds.length);
    assert.ok(sounds.includes(prefix+'a') && !sounds.includes(prefix+'b'));
    for (const sort of ['newest', 'upvotes']) {
      const videos = await all(`/api/public/videos?limit=1&sort=${sort}`, 'videos');
      assert.equal(new Set(videos).size, videos.length);
      assert.ok(videos.includes(prefix+'a') && videos.includes(prefix+'b'));
      const lores = await all(`/api/public/lores?limit=1&sort=${sort}`, 'lores');
      assert.equal(new Set(lores).size, lores.length);
    }
    const translated = await get('/api/public/lores?limit=1&q=translated&tag=adventure&language=id');
    assert.ok(translated.lores.some(item => item.id === prefix+'a'));
    assert.ok(translated.facets.tags.includes('adventure'));
    assert.ok(translated.facets.languages.some(item => item.locale === 'id'));
    const relevance = await all('/api/public/videos?limit=1&sort=relevance', 'videos');
    assert.equal(new Set(relevance).size, relevance.length);
    assert.ok(relevance.includes(prefix+'a') && relevance.includes(prefix+'b'));
    const expectedRelevance = await pool.query("SELECT count(*)::int AS n FROM app.content WHERE kind='video' AND status='Published' AND created_at IS NOT NULL");
    assert.equal(relevance.length, expectedRelevance.rows[0].n);
    const character = await get(`/api/public/characters/${prefix}a`);
    assert.equal(character.name, 'Same');
    const video = await get(`/api/public/videos/${prefix}a`);
    assert.equal(video.title, 'Video');
    const sound = await get(`/api/public/sounds/${prefix}a`);
    assert.equal(sound.sound.name, 'Legacy');
    const lore = await get(`/api/public/lores/${prefix}a`);
    assert.equal(lore.title, 'Original');
    assert.equal((await fetch(`${base}/api/public/characters/${prefix}draft`)).status, 404);
    assert.equal((await fetch(`${base}/api/public/sounds/${prefix}b`)).status, 404);
    assert.equal((await fetch(`${base}/api/public/videos?limit=1&cursor=bad`)).status, 400);
    const first = await get('/api/public/characters?limit=1');
    assert.equal((await fetch(`${base}/api/public/characters?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
  } finally {
    await reader.end();
    await pool.query('DELETE FROM app.content WHERE id LIKE $1', [prefix+'%']);
    await pool.end();
  }
});

test('public responses match the imported Firestore snapshot', { skip: !enabled || !process.env.CONTENT_TEST_EXPORT }, async () => {
  // Parse quoted CSV without exposing document contents in the test output.
  const input = await readFile(process.env.CONTENT_TEST_EXPORT, 'utf8');
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted && ch === '"' && input[i + 1] === '"') { field += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') { row.push(field); field = ''; }
    else if (!quoted && ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  assert.equal(quoted, false);
  const snapshots = rows.slice(1).map(([path, document]) => ({ path, fields: JSON.parse(document).fields ?? {} }));
  const configs = [
    ['characters', 'characters'], ['lores', 'lores'], ['videos?sort=newest', 'videos'], ['sounds', 'sounds'],
  ];
  for (const [endpoint, key] of configs) {
    const kind = endpoint.split('?')[0];
    const sourceCollection = kind === 'sounds' ? 'soundboardSounds' : kind;
    const expected = snapshots.filter(({ path, fields }) => {
      const parts = path.split('/');
      if (parts.length !== 2 || parts[0] !== sourceCollection) return false;
      const status = fields.status?.stringValue;
      if (kind === 'sounds') return (!Object.hasOwn(fields, 'status') || status === 'Published')
        && typeof fields.name?.stringValue === 'string' && typeof fields.category?.stringValue === 'string'
        && /^soundboard\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(mp3|wav|ogg|m4a|webm|aac)$/.test(fields.soundKey?.stringValue ?? '');
      if (status !== 'Published') return false;
      return kind !== 'characters' || Boolean(fields.name?.stringValue?.trim());
    });
    const found = new Map(); let cursor = null; let calls = 0;
    do {
      const url = new URL(`/api/public/${endpoint}`, base);
      url.searchParams.set('limit', '2');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      assert.ok(response.ok, `snapshot ${kind} request failed`);
      const body = await response.json();
      for (const item of body[key]) found.set(item.id, item);
      cursor = body.nextCursor;
      assert.ok(++calls < 100);
    } while (cursor);
    assert.equal(found.size, expected.length, `snapshot ${kind} count mismatch`);
    for (const { path, fields } of expected) {
      const item = found.get(path.split('/')[1]);
      assert.ok(item, `snapshot ${kind} ID mismatch`);
      const title = kind === 'sounds' ? fields.name?.stringValue : fields.title?.stringValue;
      const actual = kind === 'sounds' ? item.name : item.title;
      assert.ok((title ?? '') === (actual ?? ''), `snapshot ${kind} title mismatch`);
      if (kind === 'characters') assert.ok(fields.name?.stringValue === item.name, 'snapshot character name mismatch');
      if (kind === 'lores') assert.ok((fields.text?.stringValue ?? null) === (item.text ?? null), 'snapshot lore text mismatch');
      if (kind === 'videos') assert.ok((fields.description?.stringValue ?? '') === item.description, 'snapshot video description mismatch');
    }
  }
});
