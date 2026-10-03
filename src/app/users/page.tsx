'use client';
import { useState, type FormEvent } from 'react';
import { Pencil, Plus, RefreshCw, Trash2, UsersRound } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { Allowed, useStudioAccess } from '../../components/studio-access-provider';
import { useI18n } from '../../components/studio-i18n';
import { emptyDetails, PersonalDetailsFields } from '../../components/personal-details';
import { ListSentinel, useStudioList } from '../../components/studio-list';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { studioApi } from '../../lib/studio-client';
import type { StudioUser } from '../../lib/studio-policy.mjs';
export default function UsersPage() { return <AdminShell><Users/></AdminShell>; }
function Users() {
  const { t } = useI18n(), { profile: current, roleId } = useStudioAccess();
  const list = useStudioList<StudioUser>('/api/users');
  const [editing, setEditing] = useState<StudioUser | 'new' | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function remove(user: StudioUser) {
    if (!window.confirm(t('studio.users.removeConfirm', { name: user.displayName || user.email }))) return;
    setBusy(true); setError('');
    try { await studioApi(`/api/users/${user.sub}`, { method: 'DELETE' }); setNotice(t('studio.common.removed')); await list.load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'studio.errors.request'); }
    finally { setBusy(false); }
  }
  return <><PageHeader eyebrow={t('studio.common.eyebrow')} title={t('studio.modules.users')} description={t('studio.users.description')} action={<div className="studio-header-actions"><button className="button ghost" disabled={list.loading || busy} onClick={() => void list.load(true)}><RefreshCw size={16}/>{t('studio.common.refresh')}</button><Allowed module="users" action="add"><button className="button primary" onClick={() => { setNotice(''); setEditing('new'); }}><Plus size={16}/>{t('studio.users.add')}</button></Allowed></div>}/><Notice>{error ? t(error) : notice}</Notice>{editing !== null && <Allowed module="users" action={editing === 'new' ? 'add' : 'edit'}><UserEditor key={editing === 'new' ? 'new' : editing.sub} user={editing === 'new' ? null : editing} close={() => setEditing(null)} saved={async created => { setEditing(null); setNotice(t(created ? 'studio.users.created' : 'studio.common.saved')); await list.load(true); }}/></Allowed>}<section className="studio-records"><h2><UsersRound size={20}/>{t('studio.users.list')}</h2>{list.ready && !list.items.length && <EmptyState title={t('studio.users.empty')} description={t('studio.users.emptyDescription')}/>}<div className="studio-user-list">{list.items.map(user => <article className="studio-user-card" key={user.sub}><span className="admin-user-avatar">{user.displayName?.[0] || <UsersRound size={18}/>}</span><div className="studio-user-info"><strong>{user.displayName || user.email}</strong><small>{user.email}</small><small>{[user.firstName, user.lastName, user.country].filter(Boolean).join(' · ')}</small><span className="studio-role-badge">{!user.enabled ? t('studio.users.disabled') : user.roleId === 'root' ? t('studio.roles.root') : user.roleName || user.roleId || t('studio.fields.noRole')}</span></div><div className="studio-record-actions">{user.enabled && <Allowed module="users" action="edit"><button className="icon-button" aria-label={t('studio.common.editNamed', { name: user.displayName || user.email })} disabled={busy || (user.roleId === 'root' && roleId !== 'root')} onClick={() => setEditing(user)}><Pencil size={17}/></button></Allowed>}{user.enabled && <Allowed module="users" action="delete"><button className="icon-button danger" aria-label={t('studio.common.deleteNamed', { name: user.displayName || user.email })} disabled={busy || current?.sub === user.sub || (user.roleId === 'root' && roleId !== 'root')} onClick={() => void remove(user)}><Trash2 size={17}/></button></Allowed>}</div></article>)}</div><ListSentinel list={list}/></section></>;
}
function UserEditor({ user, close, saved }: { user: StudioUser | null; close: () => void; saved: (created: boolean) => Promise<void> }) {
  const { t } = useI18n(), { profile: current } = useStudioAccess();
  const roles = useStudioList<{ id: string; name: string }>('/api/users/role-options');
  const [details, setDetails] = useState(user ?? emptyDetails), [email, setEmail] = useState(user?.email ?? ''), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState(''), [roleId, setRoleId] = useState(user?.roleId ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!user && password !== confirmPassword) { setError('studio.errors.passwordMismatch'); return; }
    setBusy(true);
    try { await studioApi(user ? `/api/users/${user.sub}` : '/api/users', { method: user ? 'PATCH' : 'POST', body: JSON.stringify({ firstName: details.firstName, lastName: details.lastName, displayName: details.displayName, country: details.country, bio: details.bio, email, ...(!user ? { password, confirmPassword } : {}), roleId: roleId || null }) }); await saved(!user); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'studio.errors.request'); }
    finally { setBusy(false); }
  }
  return <form className="studio-editor" onSubmit={event => void submit(event)}><header><h2>{t(user ? 'studio.users.edit' : 'studio.users.add')}</h2><p>{t(user ? 'studio.users.emailImmutable' : 'studio.users.createNote')}</p></header><PersonalDetailsFields value={details} onChange={setDetails} disabled={busy}/><label>{t('studio.fields.email')}<input type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={254} autoComplete="email" disabled={busy || Boolean(user)} required/></label>{!user && <div className="form-grid"><label>{t('studio.fields.password')}<input type="password" value={password} onChange={event => setPassword(event.target.value)} minLength={8} maxLength={256} autoComplete="new-password" disabled={busy} required/></label><label>{t('studio.fields.confirmPassword')}<input type="password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={8} maxLength={256} autoComplete="new-password" disabled={busy} required/></label></div>}<label>{t('studio.fields.role')}<select aria-label={t('studio.fields.role')} value={roleId} onChange={event => setRoleId(event.target.value)} disabled={busy || current?.sub === user?.sub} required={!user}><option value="">{t('studio.fields.noRole')}</option>{user?.roleId && !roles.items.some(role => role.id === user.roleId) && <option value={user.roleId}>{user.roleId === 'root' ? t('studio.roles.root') : user.roleId}</option>}{roles.items.map(role => <option key={role.id} value={role.id}>{role.id === 'root' ? t('studio.roles.root') : role.name}</option>)}</select></label><ListSentinel list={roles}/><Notice>{error && t(error)}</Notice><div className="modal-actions"><button type="button" className="button ghost" onClick={close} disabled={busy}>{t('studio.common.cancel')}</button><button className="button primary" disabled={busy || (!user && !roleId)}>{busy ? <Spinner label={t('studio.common.saving')}/> : t(user ? 'studio.common.save' : 'studio.users.add')}</button></div></form>;
}
