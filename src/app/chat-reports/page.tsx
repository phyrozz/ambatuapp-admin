'use client';
import { useEffect, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Flag } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { authConfigured, configureAuth } from '../../lib/auth';
import type { ChatReport, ChatRestriction } from '../../lib/chat-reports';

async function api(path: string, init?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  const response = await fetch(path, { ...init, cache: 'no-store', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

export default function ChatReportsPage() {
  const [reports, setReports] = useState<ChatReport[]>([]);
  const [restrictedUsers, setRestrictedUsers] = useState<ChatRestriction[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => { void api('/api/chat-reports').then(data => { setReports(data.reports ?? []); setRestrictedUsers(data.restrictedUsers ?? []); }).catch(reason => setError(reason.message)).finally(() => setLoading(false)); }, []);
  async function resolve(id: string) {
    setBusy(id); setError('');
    try { await api(`/api/chat-reports/${id}`, { method: 'PATCH' }); setReports(items => items.map(item => item.id === id ? { ...item, status: 'resolved', resolvedAt: Date.now() } : item)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not resolve report.'); }
    finally { setBusy(''); }
  }
  async function updateRestriction(userId: string, restricted: boolean, reportId?: string) {
    setBusy('user:' + userId); setError('');
    try {
      const data = await api('/api/chat-restrictions', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId, restricted, reportId }) });
      setRestrictedUsers(items => restricted ? [data.restriction as ChatRestriction, ...items.filter(item => item.userId !== userId)] : items.filter(item => item.userId !== userId));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update chat restriction.'); }
    finally { setBusy(''); }
  }
  const restrictedIds = new Set(restrictedUsers.map(item => item.userId));
  const names = Object.assign({}, ...reports.map(item => item.names)) as Record<string, string>;
  const candidatesFor = (item: ChatReport) => {
    if (item.senderId && item.senderId !== item.reporterId) return [item.senderId];
    const members = item.members.length ? item.members : item.conversationId.startsWith('dm-') ? item.conversationId.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi) ?? [] : [];
    return [...new Set(members.filter(id => id !== item.reporterId))];
  };
  return <AdminShell>
    <PageHeader eyebrow="AMBAVERSE / SAFETY" title="Chat reports" count={reports.filter(item => item.status === 'open').length} description="Review user reports about conversations and messages."/>
    {error && <p role="alert" className="chat-report-error">{error}</p>}
    {restrictedUsers.length > 0 && <section className="chat-restrictions"><h2>Restricted from chat</h2><div className="chat-restriction-list">{restrictedUsers.map(item => <div key={item.userId} className="chat-restriction-row"><span><strong>{names[item.userId] || item.userId}</strong>{names[item.userId] && <small>{item.userId}</small>}</span><button type="button" className="button" disabled={Boolean(busy)} onClick={() => void updateRestriction(item.userId, false)}>Unrestrict</button></div>)}</div></section>}
    <div className="chat-report-list">{reports.length ? reports.map(item => {
      const candidates = candidatesFor(item);
      const targetId = selectedTargets[item.id] ?? (candidates.length === 1 ? candidates[0] : '');
      return <article key={item.id} className="chat-report-card">
        <header><Flag size={18}/><strong>{item.status === 'open' ? 'Open' : 'Resolved'}</strong><time>{new Date(item.createdAt).toLocaleString()}</time></header>
        <p>{item.reason}</p>
        {item.messageText && <blockquote>{item.messageText}</blockquote>}
        {item.mediaUrl && (item.messageKind === 'video' ? <video controls src={item.mediaUrl}/> : <img src={item.mediaUrl} alt="Reported media"/>)}
        <dl><div><dt>Conversation</dt><dd>{item.conversationId}</dd></div><div><dt>Message</dt><dd>{item.messageId || 'Whole conversation'}</dd></div>{item.messageKind && <div><dt>Kind</dt><dd>{item.messageKind}</dd></div>}{item.senderId && <div><dt>Sender</dt><dd>{item.senderId}</dd></div>}<div><dt>Reporter</dt><dd>{item.reporterId}</dd></div></dl>
        <div className="chat-report-actions">
          {candidates.length > 1 && <label>Reported user<select value={targetId} onChange={event => setSelectedTargets(items => ({ ...items, [item.id]: event.target.value }))}><option value="">Choose a user</option>{candidates.map(id => <option key={id} value={id}>{item.names[id] ? `${item.names[id]} (${id})` : id}</option>)}</select></label>}
          {candidates.length === 1 && targetId && <small>Reported user: {item.names[targetId] ? `${item.names[targetId]} (${targetId})` : targetId}</small>}
          {targetId && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => void updateRestriction(targetId, !restrictedIds.has(targetId), item.id)}>{restrictedIds.has(targetId) ? 'Unrestrict from chat' : 'Restrict from chat'}</button>}
          {!candidates.length && <small>No user identified for this report.</small>}
          {item.status === 'open' && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => void resolve(item.id)}>Mark resolved</button>}
        </div>
      </article>;
    }) : !loading && !error ? <div className="chat-report-empty">No chat reports yet.</div> : null}</div>
  </AdminShell>;
}
