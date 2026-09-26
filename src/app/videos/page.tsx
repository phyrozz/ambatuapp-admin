'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Eye, Pencil, Plus, RefreshCw, Save, Search, Trash2, Upload, Video, X } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { authConfigured, configureAuth } from '../../lib/auth';
import type { VideoStatus } from '../../lib/admin-video';

type AdminVideo = {
  id: string;
  title: string;
  description: string;
  status: VideoStatus;
  uploaderEmail: string;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string | null;
  videoUrl: string;
  thumbnailUrl: string;
};

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

async function api(path: string, options?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  return fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...options?.headers } });
}

const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

async function waitForVideoCompression(sourceKey: string, videoKey: string) {
  const start = await api('/api/videos/transcode', { method: 'POST', body: JSON.stringify({ sourceKey, videoKey }) });
  const created = await start.json();
  if (!start.ok) throw new Error(created.error || 'Could not start video compression.');
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await pause(5000);
    const response = await api(`/api/videos/transcode?jobId=${encodeURIComponent(created.jobId)}`, { method: 'GET' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check video compression.');
    if (result.status === 'COMPLETE' && result.videoKey === videoKey) return;
    if (result.status === 'ERROR' || result.status === 'CANCELED') throw new Error(result.error || 'Video compression failed.');
  }
  throw new Error('Video compression timed out.');
}

function waitForVideoMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoaded = () => finish();
    const onError = () => finish(new Error('Could not create a thumbnail from this video.'));
    const timeout = window.setTimeout(() => finish(new Error('Could not create a thumbnail from this video.')), 10000);
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error('Could not create a thumbnail from this video.'));
    const timeout = window.setTimeout(() => finish(new Error('Could not create a thumbnail from this video.')), 10000);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    try { video.currentTime = time; }
    catch { finish(new Error('Could not create a thumbnail from this video.')); }
  });
}

async function waitForVideoFrame(video: HTMLVideoElement) {
  const frameVideo = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
  if (frameVideo.requestVideoFrameCallback) {
    await new Promise<void>(resolve => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        resolve();
      };
      const timeout = window.setTimeout(finish, 300);
      frameVideo.requestVideoFrameCallback?.(finish);
    });
  }
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function hasVisiblePixels(frame: ImageData) {
  const stepX = Math.max(1, Math.floor(frame.width / 8));
  const stepY = Math.max(1, Math.floor(frame.height / 6));
  let samples = 0, visible = 0;
  for (let y = Math.floor(stepY / 2); y < frame.height; y += stepY) {
    for (let x = Math.floor(stepX / 2); x < frame.width; x += stepX) {
      const offset = (y * frame.width + x) * 4;
      const brightness = (frame.data[offset] * 299 + frame.data[offset + 1] * 587 + frame.data[offset + 2] * 114) / 1000;
      samples++;
      if (brightness > 22) visible++;
    }
  }
  return visible >= Math.min(2, samples);
}

async function thumbnailFromVideo(file: File) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await waitForVideoMetadata(video);
    if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) throw new Error('Could not create a thumbnail from this video.');
    const ratio = Math.min(1, 720 / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * ratio));
    canvas.height = Math.max(1, Math.round(video.videoHeight * ratio));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not create a thumbnail from this video.');
    const lastFrameTime = Math.max(0, video.duration - Math.min(.04, video.duration / 10));
    const times = [...new Set([Math.min(1, video.duration / 4), video.duration * .4, video.duration * .6, video.duration * .8].map(time => Math.min(lastFrameTime, Math.max(0, time))))];
    let selectedFrame: ImageData | null = null;
    for (const time of times) {
      await seekVideo(video, time);
      await waitForVideoFrame(video);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = context.getImageData(0, 0, canvas.width, canvas.height);
      if (!selectedFrame || hasVisiblePixels(frame)) selectedFrame = frame;
      if (hasVisiblePixels(frame)) break;
    }
    if (!selectedFrame) throw new Error('Could not create a thumbnail from this video.');
    context.putImageData(selectedFrame, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not create a thumbnail from this video.')), 'image/jpeg', .82));
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function uploadVideo(file: File) {
  if (file.size > MAX_VIDEO_BYTES) throw new Error('Videos must be 200 MB or smaller.');
  const thumbnail = await thumbnailFromVideo(file);
  const response = await api('/api/videos/presign', { method: 'POST', body: JSON.stringify({ fileName: file.name, contentType: file.type, fileSize: file.size }) });
  const signed = await response.json();
  if (!response.ok) throw new Error(signed.error || 'Could not prepare upload.');
  let uploads: Response[];
  try {
    uploads = await Promise.all([
      fetch(signed.sourceUploadUrl, { method: 'PUT', headers: signed.sourceUploadHeaders, body: file }),
      fetch(signed.thumbnailUploadUrl, { method: 'PUT', headers: signed.thumbnailUploadHeaders, body: thumbnail }),
    ]);
  } catch {
    throw new Error('The upload request was blocked. Check the video bucket CORS policy.');
  }
  const failed = uploads.find(item => !item.ok);
  if (failed) throw new Error(`Video upload failed (${failed.status}).`);
  await waitForVideoCompression(signed.sourceKey, signed.videoKey);
  return { videoKey: signed.videoKey as string, thumbnailKey: signed.thumbnailKey as string };
}

export default function VideosAdmin() {
  const [videos, setVideos] = useState<AdminVideo[]>([]);
  const [selected, setSelected] = useState<AdminVideo | null>(null);
  const [editing, setEditing] = useState<AdminVideo | 'new' | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'All' | VideoStatus>('All');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const visible = useMemo(() => videos.filter(video =>
    `${video.title} ${video.description} ${video.uploaderEmail}`.toLowerCase().includes(query.toLowerCase()) && (status === 'All' || video.status === status),
  ), [videos, query, status]);

  async function load() {
    setLoading(true);
    try {
      const response = await api('/api/videos');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const items: AdminVideo[] = data.videos ?? [];
      setVideos(items);
      setSelected(current => current ? items.find(item => item.id === current.id) ?? items[0] ?? null : items[0] ?? null);
      setNotice('');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load videos.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void api('/api/videos').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      if (!active) return;
      const items: AdminVideo[] = data.videos ?? [];
      setVideos(items);
      setSelected(items[0] ?? null);
    }).catch(error => {
      if (active) setNotice(error instanceof Error ? error.message : 'Could not load videos.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function save(fields: { title: string; description: string; status: VideoStatus }, file: File | null) {
    const existing = editing && editing !== 'new' ? editing : null;
    try {
      const keys = file ? await uploadVideo(file) : {};
      const response = await api(existing ? `/api/videos/${existing.id}` : '/api/videos', {
        method: existing ? 'PATCH' : 'POST',
        body: JSON.stringify({ ...fields, ...keys }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setVideos(items => existing ? items.map(item => item.id === data.id ? data : item) : [data, ...items]);
      setSelected(data);
      setEditing(null);
      setNotice(`${data.title} was saved.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not save video.');
      return false;
    }
  }

  async function remove(video: AdminVideo) {
    if (!confirm(`Delete ${video.title}? The video, thumbnail, votes, and comments will be removed.`)) return;
    try {
      const response = await api(`/api/videos/${video.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      const remaining = videos.filter(item => item.id !== video.id);
      setVideos(remaining);
      setSelected(remaining[0] ?? null);
      setEditing(null);
      setNotice(`${video.title} was deleted.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete video.');
    }
  }

  const create = () => { setSelected(null); setEditing('new'); setNotice(''); };
  return <AdminShell>
    <PageHeader eyebrow="AMBAVERSE / MEDIA" title="Videos" count={videos.length} description="Manage videos shared on AmbatuWatch and publish your own." action={<button className="button primary" onClick={create}><Plus size={17}/>Add video</button>}/>
    <Notice>{notice}</Notice>
    <div className="admin-toolbar"><label className="search-control"><Search size={17}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search videos"/></label><select value={status} onChange={event => setStatus(event.target.value as typeof status)}><option>All</option><option>Published</option><option>Draft</option></select><button className="icon-button" aria-label="Refresh videos" onClick={() => void load()} disabled={loading}>{loading ? <Spinner/> : <RefreshCw size={17}/>}</button><span>{visible.length} of {videos.length}</span></div>
    {loading && !videos.length ? <div className="section-loader"><Spinner label="Loading videos"/></div> : <div className="video-admin-split">
      <aside className="video-admin-list"><div className="lore-list-heading"><strong>All videos</strong><span>{visible.length}</span></div>{visible.map(video => <button key={video.id} className={selected?.id === video.id && !editing ? 'active' : ''} onClick={() => { setSelected(video); setEditing(null); }}><span className="video-admin-list-thumb">{video.thumbnailUrl ? <img src={video.thumbnailUrl} alt=""/> : <Video size={20}/>}</span><span><strong>{video.title}</strong><small>{video.status} · {video.uploaderEmail}</small></span></button>)}{!visible.length && <p className="lore-list-empty">No matching videos.</p>}</aside>
      <section className="video-admin-detail">{editing ? <VideoForm key={editing === 'new' ? 'new' : editing.id} video={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSave={save}/> : selected ? <VideoView video={selected} onEdit={() => setEditing(selected)} onDelete={() => void remove(selected)}/> : <EmptyState title="Choose a video" description="Select a video or upload a new one." action={<button className="button primary" onClick={create}><Plus size={17}/>Add video</button>}/>}</section>
    </div>}
  </AdminShell>;
}

function VideoView({ video, onEdit, onDelete }: { video: AdminVideo; onEdit: () => void; onDelete: () => void }) {
  return <article className="video-admin-view"><div className="detail-actions"><span className={`status ${video.status.toLowerCase()}`}>{video.status}</span><button className="button ghost" onClick={onEdit}><Pencil size={16}/>Edit</button><button className="icon-button danger" aria-label={`Delete ${video.title}`} onClick={onDelete}><Trash2 size={16}/></button></div><div className="video-admin-preview">{video.videoUrl ? <video key={video.id} controls playsInline preload="auto" poster={video.thumbnailUrl} src={video.videoUrl} aria-label={`Watch ${video.title}`}/> : <Video size={38}/>}</div><p className="eyebrow">AMBATUWATCH / VIDEO</p><h2>{video.title}</h2><p className="video-admin-uploader">Uploaded by {video.uploaderEmail}{video.createdAt ? ` · ${new Date(video.createdAt).toLocaleDateString()}` : ''}</p><p className="video-admin-description">{video.description || 'No description added.'}</p><footer><Eye size={15}/>{video.status === 'Published' ? 'Visible on AmbatuWatch' : 'Hidden from AmbatuWatch'} · {video.upvotes} upvotes · {video.downvotes} downvotes · {video.commentCount} comments</footer></article>;
}

function VideoForm({ video, onCancel, onSave }: { video: AdminVideo | null; onCancel: () => void; onSave: (fields: { title: string; description: string; status: VideoStatus }, file: File | null) => Promise<boolean> }) {
  const [title, setTitle] = useState(video?.title ?? '');
  const [description, setDescription] = useState(video?.description ?? '');
  const [status, setStatus] = useState<VideoStatus>(video?.status ?? 'Published');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!video && !file) { setError('Choose a video file.'); return; }
    if (file && file.size > MAX_VIDEO_BYTES) { setError('Videos must be 200 MB or smaller.'); return; }
    setError('');
    setBusy(true);
    try { await onSave({ title, description, status }, file); } finally { setBusy(false); }
  }
  return <form className="video-admin-form" onSubmit={event => void submit(event)}><div className="detail-actions"><span className="detail-mode"><Pencil size={15}/>{video ? 'Editing video' : 'New video'}</span><button type="button" className="icon-button" aria-label="Close editor" onClick={onCancel}><X size={18}/></button></div><label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required/></label><label>Description<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={1000} rows={5}/><small>{description.length} / 1,000 characters</small></label><label className="image-picker video-admin-picker"><span>{video?.thumbnailUrl && !file ? <img src={video.thumbnailUrl} alt=""/> : <Upload size={25}/>}</span><div><strong>{file?.name ?? (video ? 'Replace video file' : 'Choose video file')}</strong><small>MP4, WebM, or MOV · 200 MB maximum{video && !file ? ' · current file retained' : ''}</small></div><input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={event => setFile(event.target.files?.[0] ?? null)} disabled={busy}/></label><div className="form-grid"><label>Status<select value={status} onChange={event => setStatus(event.target.value as VideoStatus)}><option>Published</option><option>Draft</option></select></label></div><Notice>{error}</Notice><div className="modal-actions"><button className="button ghost" type="button" onClick={onCancel} disabled={busy}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <Spinner label={file ? 'Uploading video' : 'Saving'}/> : <><Save size={16}/>Save video</>}</button></div></form>;
}
