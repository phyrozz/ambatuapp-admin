'use client';
import { useState, type FormEvent } from 'react';
import { Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { Allowed } from '../../components/studio-access-provider';
import { useI18n } from '../../components/studio-i18n';
import { ListSentinel, useStudioList } from '../../components/studio-list';
import { EmptyState, Notice, Spinner } from '../../components/admin-ui';
import { studioApi } from '../../lib/studio-client';
import { ROLE_TYPES, STUDIO_MODULES, type Permissions, type StudioRole, type ModuleId, type RoleType } from '../../lib/studio-policy.mjs';
export default function RolesPage() { return <AdminShell><Roles/></AdminShell>; }
function Roles() {
  const { t } = useI18n(), list = useStudioList<StudioRole>('/api/roles');
  const [editing, setEditing] = useState<StudioRole | 'new' | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function remove(role: StudioRole) {
    if (!window.confirm(t('studio.roles.deleteConfirm', { name: role.name }))) return;
    setBusy(true); setError('');
    try { await studioApi(`/api/roles/${role.id}`, { method: 'DELETE' }); setNotice(t('studio.roles.deleted')); await list.load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'studio.errors.request'); }
    finally { setBusy(false); }
  }
  return <><PageHeader eyebrow={t('studio.common.eyebrow')} title={t('studio.modules.roles')} description={t('studio.roles.description')} action={<div className="studio-header-actions"><button className="button ghost" disabled={list.loading || busy} onClick={() => void list.load(true)}><RefreshCw size={16}/>{t('studio.common.refresh')}</button><Allowed module="roles" action="add"><button className="button primary" onClick={() => setEditing('new')}><Plus size={16}/>{t('studio.roles.add')}</button></Allowed></div>}/><Notice>{error ? t(error) : notice}</Notice><p className="studio-help">{t('studio.roles.futureNote')}</p>{editing !== null && <Allowed module="roles" action={editing === 'new' ? 'add' : 'edit'}><RoleEditor key={editing === 'new' ? 'new' : editing.id} role={editing === 'new' ? null : editing} close={() => setEditing(null)} saved={async () => { setEditing(null); setNotice(t('studio.common.saved')); await list.load(true); }}/></Allowed>}<section className="studio-records">{list.ready && !list.items.length && <EmptyState title={t('studio.roles.empty')} description={t('studio.roles.emptyDescription')}/>}<div className="studio-role-list">{list.items.map(role => <article className="studio-role-card" key={role.id}><header><ShieldCheck size={22}/><div><h2>{role.id === 'root' ? t('studio.roles.root') : role.name}</h2><small>{t('studio.roles.users', { count: role.userCount ?? 0 })}</small></div>{role.id !== 'root' && <div className="studio-record-actions"><Allowed module="roles" action="edit"><button className="icon-button" aria-label={t('studio.common.editNamed', { name: role.name })} onClick={() => setEditing(role)} disabled={busy}><Pencil size={17}/></button></Allowed><Allowed module="roles" action="delete"><button className="icon-button danger" aria-label={t('studio.common.deleteNamed', { name: role.name })} disabled={busy || role.userCount > 0} onClick={() => void remove(role)}><Trash2 size={17}/></button></Allowed></div>}</header><p>{role.id === 'root' ? t('studio.roles.rootNote') : role.description}</p><div className="studio-permission-summary">{STUDIO_MODULES.filter(module => role.permissions?.[module.id]?.length).map(module => <div key={module.id}><strong>{t(module.key)}</strong><small>{role.permissions[module.id]?.map(action => t(`studio.actions.${action}`)).join(', ')}</small></div>)}</div></article>)}</div><ListSentinel list={list}/></section></>;
}
function RoleEditor({ role, close, saved }: { role: StudioRole | null; close: () => void; saved: () => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState(role?.name ?? ''), [description, setDescription] = useState(role?.description ?? ''), [permissions, setPermissions] = useState<Permissions>(role?.permissions ?? {}), [busy, setBusy] = useState(false), [error, setError] = useState('');
  function toggle(module: ModuleId, action: RoleType, checked: boolean) {
    setPermissions(prior => {
      const actions = new Set(prior[module] ?? []);
      if (checked) { actions.add(action); actions.add('view'); } else if (action === 'view') actions.clear(); else actions.delete(action);
      return { ...prior, [module]: ROLE_TYPES.filter(item => actions.has(item)) };
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await studioApi(role ? `/api/roles/${role.id}` : '/api/roles', { method: role ? 'PATCH' : 'POST', body: JSON.stringify({ name, description, permissions }) }); await saved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'studio.errors.request'); }
    finally { setBusy(false); }
  }
  return <form className="studio-editor" onSubmit={event => void submit(event)}><h2>{t(role ? 'studio.roles.edit' : 'studio.roles.add')}</h2><label>{t('studio.roles.name')}<input value={name} onChange={event => setName(event.target.value)} maxLength={80} required disabled={busy}/></label><label>{t('studio.roles.notes')}<textarea value={description} onChange={event => setDescription(event.target.value)} maxLength={500} rows={2} disabled={busy}/></label><p className="studio-help">{t('studio.roles.viewNote')}</p><div className="studio-permission-table"><table><thead><tr><th scope="col">{t('studio.roles.module')}</th>{ROLE_TYPES.map(action => <th scope="col" key={action}>{t(`studio.actions.${action}`)}</th>)}</tr></thead><tbody>{STUDIO_MODULES.map(module => <tr key={module.id}><th scope="row">{t(module.key)}</th>{ROLE_TYPES.map(action => <td key={action}><label className="studio-permission-toggle"><input type="checkbox" aria-label={t('studio.roles.permissionLabel', { action: t(`studio.actions.${action}`), module: t(module.key) })} checked={permissions[module.id]?.includes(action) ?? false} onChange={event => toggle(module.id, action, event.target.checked)} disabled={busy}/></label></td>)}</tr>)}</tbody></table></div><Notice>{error && t(error)}</Notice><div className="modal-actions"><button type="button" className="button ghost" onClick={close} disabled={busy}>{t('studio.common.cancel')}</button><button className="button primary" disabled={busy}>{busy ? <Spinner label={t('studio.common.saving')}/> : t('studio.common.save')}</button></div></form>;
}
