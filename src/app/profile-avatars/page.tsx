'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { ImagePlus, RefreshCw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { authConfigured, configureAuth } from '../../lib/auth';

type AvatarPreset = { id: string; name: string; imageUrl: string | null; userCount: number };
type CustomAvatar = { userId: string; username: string; imageUrl: string | null };

async function api(path: string, init?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  const isForm = init?.body instanceof FormData;
  const response = await fetch(path, { ...init, cache: 'no-store', headers: { ...(!isForm && init?.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

export default function ProfileAvatarsPage() {
  const [presets, setPresets] = useState<AvatarPreset[]>([]);
  const [active, setActive] = useState<CustomAvatar[]>([]);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      const [presetData, moderationData] = await Promise.all([api('/api/profile-avatars'), api('/api/profile-avatar-moderation')]);
      setPresets(presetData.avatars ?? []); setActive(moderationData.active ?? []); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not load profile images.'); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const refresh = window.setInterval(() => { void load(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(refresh); };
  }, []);

  async function addPreset(event: FormEvent) {
    event.preventDefault();
    if (!file) { setError('Choose a PNG or JPG image first.'); return; }
    setBusy('add'); setError(''); setNotice('');
    try {
      const form = new FormData(); form.set('name', name); form.set('image', file);
      await api('/api/profile-avatars', { method: 'POST', body: form });
      setName(''); setFile(null);
      const input = document.getElementById('profile-avatar-file') as HTMLInputElement | null;
      if (input) input.value = '';
      setNotice('Dreamy avatar added.'); await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not add avatar.'); }
    finally { setBusy(''); }
  }

  async function deletePreset(preset: AvatarPreset) {
    setBusy(preset.id); setError(''); setNotice('');
    try { await api(`/api/profile-avatars/${preset.id}`, { method: 'DELETE' }); setPresets(items => items.filter(item => item.id !== preset.id)); setNotice(`${preset.name} was deleted.`); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not delete avatar.'); }
    finally { setBusy(''); }
  }

  async function removeCustomImage(item: CustomAvatar) {
    setBusy(item.userId); setError(''); setNotice('');
    try {
      await api(`/api/profile-avatar-moderation/${encodeURIComponent(item.userId)}`, { method: 'PATCH', body: JSON.stringify({ decision: 'remove' }) });
      setActive(items => items.filter(entry => entry.userId !== item.userId));
      setNotice(`${item.username}'s custom image was removed.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not remove profile image.'); }
    finally { setBusy(''); }
  }

  return <AdminShell>
    <PageHeader eyebrow="AMBAVERSE / SAFETY" title="Profile images" count={active.length} description="Monitor public custom images and manage the Dreamy avatar collection." action={<button type="button" className="button ghost" onClick={() => { setLoading(true); setError(''); void load(); }} disabled={loading}>{loading ? <Spinner/> : <RefreshCw size={16}/>}Refresh</button>}/>
    {error && <Notice>{error}</Notice>}{notice && <p className="avatar-admin-notice" role="status">{notice}</p>}
    <section className="avatar-admin-section">
      <header><div><h2><ShieldCheck size={19}/>Custom image monitoring</h2><p>Custom images are visible publicly as soon as users upload them.</p></div><span className="avatar-admin-count">{active.length} in use</span></header>
      <p className="avatar-admin-policy">Monitor these images and remove any explicit or inappropriate content. This list refreshes automatically every 30 seconds.</p>
      {loading && !active.length ? <div className="section-loader"><Spinner label="Loading profile images"/></div> : active.length ? <div className="avatar-admin-grid">{active.map(item => <article className="avatar-admin-card" key={item.userId}><div className="avatar-admin-preview">{item.imageUrl ? <img src={item.imageUrl} alt={`Custom profile image used by ${item.username}`}/> : <ImagePlus size={28}/>}</div><div className="avatar-admin-card-body"><strong>{item.username}</strong><small>{item.userId}</small><div className="avatar-admin-actions"><button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => void removeCustomImage(item)}><Trash2 size={16}/>Remove image</button></div></div></article>)}</div> : <EmptyState title="No custom images in use" description="User uploaded profile images will appear here for monitoring."/>}
    </section>

    <section className="avatar-admin-section">
      <header><div><h2><ImagePlus size={19}/>Dreamy avatar collection</h2><p>Add preset images users can select from their profile.</p></div><span className="avatar-admin-count">{presets.length} avatars</span></header>
      <form className="avatar-preset-form" onSubmit={(event) => void addPreset(event)}><label>Avatar name<input value={name} onChange={event => setName(event.target.value)} maxLength={48} required placeholder="Dreamy classic"/></label><label className="avatar-preset-file"><Upload size={17}/><span>{file?.name ?? 'Choose a PNG or JPG image (under 3 MB)'}</span><input id="profile-avatar-file" type="file" accept="image/png,image/jpeg" onChange={event => setFile(event.target.files?.[0] ?? null)} required/></label><button type="submit" className="button primary" disabled={busy === 'add'}>{busy === 'add' ? <Spinner label="Adding"/> : <><ImagePlus size={16}/>Add avatar</>}</button></form>
      {loading && !presets.length ? <div className="section-loader"><Spinner label="Loading avatars"/></div> : presets.length ? <div className="avatar-admin-presets">{presets.map(preset => <article className="avatar-admin-preset" key={preset.id}><div className="avatar-admin-preset-image">{preset.imageUrl ? <img src={preset.imageUrl} alt=""/> : <ImagePlus size={24}/>}</div><strong>{preset.name}</strong><small>{preset.userCount} {preset.userCount === 1 ? 'user' : 'users'}</small><button type="button" className="button ghost" disabled={Boolean(busy) || preset.userCount > 0} title={preset.userCount > 0 ? 'This avatar is assigned to users.' : 'Delete avatar'} onClick={() => void deletePreset(preset)}><Trash2 size={15}/>Delete</button></article>)}</div> : <EmptyState title="No preset avatars yet" description="Add a Dreamy avatar above to make it available to users."/>}
    </section>
  </AdminShell>;
}
