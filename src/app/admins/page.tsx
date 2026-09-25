'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Clock3, Mail, RefreshCw, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { authConfigured, configureAuth } from '../../lib/auth';

type AdminUser = {
  username: string;
  sub: string;
  email: string;
  status: string;
  enabled: boolean;
  createdAt: string | null;
};

async function api(path: string, options?: RequestInit) {
  configureAuth();
  const token = authConfigured() ? (await fetchAuthSession()).tokens?.idToken?.toString() : undefined;
  const response = await fetch(path, {
    ...options,
    cache: 'no-store',
    headers: {
      ...(options?.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function readableDate(value: string | null) {
  if (!value) return 'Date unavailable';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
}

export default function AdminUsersPage() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [currentAdminSub, setCurrentAdminSub] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    try {
      const data = await api('/api/admin-users');
      setAdmins(data.admins ?? []);
      setCurrentAdminSub(data.currentAdminSub ?? null);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load administrators.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(initial);
  }, []);

  async function addAdmin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api('/api/admin-users', { method: 'POST', body: JSON.stringify({ email }) });
      setEmail('');
      setNotice(result.message || `Invitation sent to ${email}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not invite administrator.');
    } finally {
      setBusy(false);
    }
  }

  async function removeAdmin(admin: AdminUser) {
    if (!window.confirm(`Remove administrator access for ${admin.email}? They will keep their Cognito account but lose access to this console.`)) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/admin-users', { method: 'DELETE', body: JSON.stringify({ username: admin.username }) });
      setAdmins(items => items.filter(item => item.username !== admin.username));
      setNotice(`${admin.email} was removed from the admin team.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not remove administrator.');
    } finally {
      setBusy(false);
    }
  }

  return <AdminShell>
    <PageHeader
      eyebrow="AMBAVERSE / ACCESS"
      title="Administrators"
      count={admins.length}
      description="Invite and manage the people who can access this console."
      action={<button className="button ghost" type="button" onClick={() => void load()} disabled={loading || busy}><RefreshCw size={16}/>{loading ? 'Refreshing' : 'Refresh'}</button>}
    />
    {error && <Notice>{error}</Notice>}
    {notice && <p className="avatar-admin-notice" role="status">{notice}</p>}
    <div className="admin-users-layout">
      <form className="admin-user-invite" onSubmit={event => void addAdmin(event)}>
        <header>
          <span><UserPlus size={18}/></span>
          <div><h2>Invite an administrator</h2><p>They will receive a sign-in invitation by email.</p></div>
        </header>
        <label>Email address<input type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} autoComplete="email" placeholder="name@example.com" required disabled={busy}/></label>
        <p className="admin-user-invite-note"><Mail size={15}/>The invited admin sets a new password the first time they sign in.</p>
        <button className="button primary" disabled={busy}>{busy ? <Spinner label="Sending invitation"/> : <><UserPlus size={16}/>Send invitation</>}</button>
      </form>

      <section className="admin-users-list">
        <header><div><h2><ShieldCheck size={19}/>Admin team</h2><p>Only members of the Admins group can use this console.</p></div><span>{admins.length}</span></header>
        {loading && !admins.length ? <div className="section-loader"><Spinner label="Loading administrators"/></div> : admins.length ? <div className="admin-users-rows">{admins.map(admin => {
          const isCurrent = admin.sub === currentAdminSub;
          const cannotRemove = busy || isCurrent || admins.length < 2;
          return <article className="admin-user-row" key={admin.username}>
            <span className="admin-user-avatar"><ShieldCheck size={18}/></span>
            <div className="admin-user-info"><strong>{admin.email}</strong><small><Clock3 size={12}/>{isCurrent ? 'You' : readableDate(admin.createdAt)}</small></div>
            <span className={`admin-user-status ${admin.enabled ? 'enabled' : 'disabled'}`}>{admin.enabled ? admin.status.replaceAll('_', ' ').toLowerCase() : 'disabled'}</span>
            <button className="icon-button danger" type="button" aria-label={`Remove ${admin.email}`} title={isCurrent ? 'You cannot remove your own account' : admins.length < 2 ? 'At least one administrator must remain' : 'Remove administrator'} disabled={cannotRemove} onClick={() => void removeAdmin(admin)}><Trash2 size={16}/></button>
          </article>;
        })}</div> : <EmptyState title="No administrators found" description="Check that the Cognito Admins group exists and contains an administrator account."/>}
      </section>
    </div>
  </AdminShell>;
}
