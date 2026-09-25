'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { AudioLines, Music2, Plus, RefreshCw, Upload } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { authConfigured, configureAuth } from '../../lib/auth';

type AdminSound = {
  id: string;
  name: string;
  category: string;
  color: number;
  audioUrl: string;
  createdAt: string | null;
};

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

async function api(path: string, options?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: { ...(options?.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

async function uploadSound(file: File) {
  if (file.size <= 0 || file.size > MAX_AUDIO_BYTES) throw new Error('Audio clips must be 20 MB or smaller.');
  const response = await api('/api/sounds/presign', {
    method: 'POST',
    body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size }),
  });
  let upload: Response;
  try {
    upload = await fetch(response.uploadUrl, { method: 'PUT', headers: response.uploadHeaders, body: file });
  } catch {
    throw new Error('The upload request was blocked. Check the media bucket CORS policy.');
  }
  if (!upload.ok) throw new Error(`Audio upload failed (${upload.status}).`);
  return response.soundKey as string;
}

export default function SoundsAdmin() {
  const [sounds, setSounds] = useState<AdminSound[]>([]);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Classics');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    try {
      const data = await api('/api/sounds');
      setSounds(data.sounds ?? []);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load the sound catalog.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(initial);
  }, []);

  async function addSound(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!file) { setError('Choose an audio file first.'); return; }
    if (!file.type.startsWith('audio/')) { setError('Choose a supported audio file.'); return; }
    setBusy(true);
    try {
      const soundKey = await uploadSound(file);
      const created = await api('/api/sounds', {
        method: 'POST',
        body: JSON.stringify({ name, category, soundKey }),
      }) as AdminSound;
      setSounds(items => [...items, created].sort((a, b) => a.name.localeCompare(b.name)));
      setName('');
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setNotice(`${created.name} is now available in AmbatuChat and Soundboard.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not add sound.');
    } finally {
      setBusy(false);
    }
  }

  return <AdminShell>
    <PageHeader eyebrow="AMBAVERSE / AUDIO" title="Soundboard" count={sounds.length} description="Add audio clips for AmbatuChat and the Soundboard page." action={<button type="button" className="button ghost" onClick={() => void load()} disabled={loading}><RefreshCw size={16}/>{loading ? 'Refreshing' : 'Refresh'}</button>}/>
    {error && <Notice>{error}</Notice>}
    {notice && <p className="avatar-admin-notice" role="status">{notice}</p>}
    <div className="sound-admin-layout">
      <form className="sound-admin-form" onSubmit={event => void addSound(event)}>
        <header><span><Plus size={17}/></span><div><h2>Add a sound</h2><p>New clips become available as soon as they are saved.</p></div></header>
        <label>Sound name<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required placeholder="Ambatukam remix"/></label>
        <label>Category<input value={category} onChange={event => setCategory(event.target.value)} maxLength={48} required placeholder="Classics"/></label>
        <label className="sound-admin-file"><Upload size={20}/><span><strong>{file?.name ?? 'Choose an audio file'}</strong><small>MP3, WAV, OGG, M4A, AAC, or WebM · 20 MB maximum</small></span><input ref={fileInput} type="file" accept="audio/mpeg,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/webm,audio/aac" onChange={event => setFile(event.target.files?.[0] ?? null)} disabled={busy} required/></label>
        <button className="button primary" disabled={busy}>{busy ? <Spinner label="Uploading sound"/> : <><Plus size={16}/>Add sound</>}</button>
      </form>
      <section className="sound-admin-catalog">
        <header><div><h2><AudioLines size={19}/>Available sounds</h2><p>These clips appear in the public soundboard and chat picker.</p></div><span>{sounds.length}</span></header>
        {loading && !sounds.length ? <div className="section-loader"><Spinner label="Loading sounds"/></div> : sounds.length ? <div className="sound-admin-list">{sounds.map(sound => <article key={sound.id}><span className={`sound-admin-icon sound-color-${sound.color}`}><Music2 size={18}/></span><div className="sound-admin-meta"><strong>{sound.name}</strong><small>{sound.category}</small></div><audio controls preload="none" src={sound.audioUrl} aria-label={`Preview ${sound.name}`}/></article>)}</div> : <EmptyState title="No sounds yet" description="Add an audio clip to make it available in AmbatuChat and Soundboard."/>}
      </section>
    </div>
  </AdminShell>;
}
