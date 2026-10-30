'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ImagePlus, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { configureAuth, authConfigured } from '../lib/auth';
import { StudioAuth } from '../components/studio-auth';
import { studioApi } from '../lib/studio-client';
import { Allowed } from '../components/studio-access-provider';
import type { Character } from '../lib/character';
import { AdminShell, PageHeader } from '../components/admin-shell';
import { EmptyState, LoadingScreen, Notice, Spinner } from '../components/admin-ui';
import { CharacterEditor } from '../components/character-editor';

async function api(path: string, options?: RequestInit) {
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  return fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options?.headers } });
}

export default function Home() {
  const [authenticated, setAuthenticated] = useState(false), [authReady, setAuthReady] = useState(false);
  const [characters, setCharacters] = useState<Character[]>([]), [selected, setSelected] = useState<Character | null>(null), [editing, setEditing] = useState<Character | null>(null);
  const [query, setQuery] = useState(''), [status, setStatus] = useState<'All' | 'Published' | 'Draft'>('All'), [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false), [loadingMore, setLoadingMore] = useState(false), [cursor, setCursor] = useState<string | null>(null), [moreError, setMoreError] = useState(false);
  const generation = useRef(0), inFlight = useRef(false), listRef = useRef<HTMLElement>(null), sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      if (!authConfigured() || !configureAuth()) { setAuthenticated(true); setAuthReady(true); return; }
      try { const token = (await fetchAuthSession()).tokens?.idToken; if (token) { await studioApi('/api/admin-session'); setAuthenticated(true); } }
      catch {} finally { setAuthReady(true); }
    })();
  }, []);

  const fetchPage = useCallback(async (next: string | null, requestGeneration: number) => {
    const params = new URLSearchParams({ limit: '30' });
    if (query.trim()) params.set('q', query.trim());
    if (status !== 'All') params.set('status', status);
    if (next) params.set('cursor', next);
    const response = await api(`/api/characters?${params}`);
    const data = await response.json() as { characters?: Character[]; nextCursor?: string | null; error?: string };
    if (!response.ok) throw new Error(data.error);
    if (requestGeneration !== generation.current) return;
    const page = Array.isArray(data.characters) ? data.characters : [];
    setCharacters(current => {
      if (!next) return page;
      const known = new Set(current.map(item => item.id));
      return [...current, ...page.filter(item => !known.has(item.id))];
    });
    if (!next) setSelected(current => current ? page.find(item => item.id === current.id) ?? null : page[0] ?? null);
    setCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
  }, [query, status]);

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    inFlight.current = false;
    setLoading(true); setLoadingMore(false); setCursor(null); setMoreError(false);
    try { await fetchPage(null, requestGeneration); }
    catch (error) { if (requestGeneration === generation.current) setNotice(error instanceof Error ? error.message : 'Could not load characters.'); }
    finally { if (requestGeneration === generation.current) setLoading(false); }
  }, [fetchPage]);
  useEffect(() => {
    if (!authenticated) return;
    const currentGeneration = generation;
    const timer = setTimeout(() => { void load(); }, 250);
    return () => { clearTimeout(timer); currentGeneration.current++; };
  }, [authenticated, load]);
  const loadMore = useCallback(async () => {
    if (!cursor || loading || inFlight.current) return;
    const requestGeneration = generation.current;
    inFlight.current = true; setLoadingMore(true); setMoreError(false);
    try { await fetchPage(cursor, requestGeneration); }
    catch { if (requestGeneration === generation.current) setMoreError(true); }
    finally { if (requestGeneration === generation.current) { inFlight.current = false; setLoadingMore(false); } }
  }, [cursor, fetchPage, loading]);
  useEffect(() => {
    const root = listRef.current, target = sentinelRef.current;
    if (!root || !target || !cursor || loading || loadingMore || moreError) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void loadMore(); }, { root, rootMargin: '150px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [cursor, loadMore, loading, loadingMore, moreError]);

  async function save(value: Character) {
    try {
      const exists = characters.some(item => item.id === value.id);
      const response = await api(exists ? `/api/characters/${value.id}` : '/api/characters', { method: exists ? 'PATCH' : 'POST', body: JSON.stringify(value) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setCharacters(items => exists ? items.map(item => item.id === value.id ? data : item) : [data, ...items]);
      setSelected(data); setNotice(`${value.name} was saved.`); return true;
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save character.'); return false; }
  }
  async function remove(character: Character) {
    if (!confirm(`Delete ${character.name}? Its S3 image will also be removed.`)) return;
    const response = await api(`/api/characters/${character.id}`, { method: 'DELETE' }), data = await response.json();
    if (!response.ok) { setNotice(data.error); return; }
    const remaining = characters.filter(item => item.id !== character.id);
    setCharacters(remaining); setSelected(remaining[0] ?? null); setEditing(null);
  }
  if (!authReady) return <LoadingScreen />;
  if (!authenticated) return <StudioAuth signedIn={() => setAuthenticated(true)} />;
  const create = () => { setSelected(null); setEditing({ id: crypto.randomUUID(), name: '', title: '', bio: '', status: 'Draft', tags: [], updated: 'Just now' }); };
  return (
    <AdminShell onSignedOut={() => setAuthenticated(false)}>
      <PageHeader eyebrow="AMBAVERSE / CHARACTERS" title="Characters" count={characters.length} description="Select a character to view or edit its profile." action={
        <Allowed module="characters" action="add">
          <button className="button primary" onClick={create}>
            <Plus size={17} />
            Add character
          </button>
        </Allowed>
      } />
      <Notice>{notice}</Notice>
      <div className="admin-toolbar">
        <label className="search-control">
          <Search size={17} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search characters" />
        </label>
        <select value={status} onChange={event => setStatus(event.target.value as typeof status)}>
          <option>All</option>
          <option>Published</option>
          <option>Draft</option>
        </select>
        <button className="icon-button" onClick={() => void load()} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw size={17} />}
        </button>
        <span>{characters.length} loaded</span>
      </div>
      {loading && !characters.length ? (
        <div className="section-loader">
          <Spinner label="Loading characters" />
        </div>
      ) : (
        <div className="character-split">
          <aside className="character-list" ref={listRef}>
            <div className="lore-list-heading">
              <strong>All characters</strong>
              <span>{characters.length}</span>
            </div>
            {characters.map(character => (
              <button key={character.id} className={selected?.id === character.id && !editing ? 'active' : ''} onClick={() => { setSelected(character); setEditing(null); }}>
                <span className="character-list-thumb">
                  {character.imageUrl ? <img src={character.imageUrl} alt="" /> : <ImagePlus size={18} />}
                </span>
                <span>
                  <strong>{character.name}</strong>
                  <small>{character.status} · {character.title || 'No title'}</small>
                </span>
              </button>
            ))}
            {!characters.length && !loading && <p className="lore-list-empty">No matching characters.</p>}
            {cursor && (
              <div ref={sentinelRef}>
                {loadingMore && <Spinner label="Loading characters" />}
                {moreError && <button type="button" onClick={() => void loadMore()}>Retry</button>}
              </div>
            )}
          </aside>
          <section className="character-detail-pane">
            {editing ? (
              <Allowed module="characters" action={characters.some(item => item.id === editing.id) ? 'edit' : 'add'}>
                <CharacterEditor inline character={editing} close={() => setEditing(null)} save={save} />
              </Allowed>
            ) : selected ? (
              <CharacterView character={selected} edit={() => setEditing({ ...selected })} remove={() => void remove(selected)} />
            ) : (
              <EmptyState title="Choose a character" description="Select an item from the list or create a new character." action={
                <Allowed module="characters" action="add">
                  <button className="button primary" onClick={create}>
                    <Plus size={17} />
                    Add character
                  </button>
                </Allowed>
              } />
            )}
          </section>
        </div>
      )}
    </AdminShell>
  );
}

function CharacterView({ character, edit, remove }: { character: Character; edit: () => void; remove: () => void }) {
  return (
    <article className="character-admin-view">
      <div className="detail-actions">
        <span className={`status ${character.status.toLowerCase()}`}>{character.status}</span>
        <Allowed module="characters" action="edit">
          <button className="button ghost" onClick={edit}>
            <Pencil size={16} />
            Edit
          </button>
        </Allowed>
        <Allowed module="characters" action="delete">
          <button className="icon-button danger" onClick={remove}>
            <Trash2 size={17} />
          </button>
        </Allowed>
      </div>
      <div className="character-hero">
        {character.imageUrl ? <img src={character.imageUrl} alt={character.name} /> : (
          <div>
            <ImagePlus size={32} />
          </div>
        )}
      </div>
      <p className="eyebrow">{character.title || 'AMBAVERSE CHARACTER'}</p>
      <h2>{character.name}</h2>
      <div className="tag-row">
        {character.tags.map(tag => <span key={tag}>{tag}</span>)}
      </div>
      <div className="character-admin-bio">{character.bio || 'No biography has been added yet.'}</div>
      <footer>Updated {character.updated}</footer>
    </article>
  );
}
