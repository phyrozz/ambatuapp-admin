'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { Notice, Spinner } from '../../components/admin-ui';
import { useStudioAccess } from '../../components/studio-access-provider';
import { useI18n } from '../../components/studio-i18n';
import { studioApi } from '../../lib/studio-client';
import { CHAT_LIMIT_DEFAULTS, type ChatLimits, type LimitKey } from '../../lib/chat-settings-schema';

export default function SettingsPage() {
  return (
    <AdminShell>
      <Settings />
    </AdminShell>
  );
}

function Settings() {
  const { t } = useI18n();
  const { can } = useStudioAccess();
  const [limits, setLimits] = useState<ChatLimits | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const canEdit = can('settings', 'edit');

  useEffect(() => {
    let active = true;
    studioApi('/api/settings').then(data => {
      if (active) { setLimits(data.limits); setVersion(data.version); }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'studio.errors.request'); });
    return () => { active = false; };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!limits) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await studioApi('/api/settings', { method: 'PUT', body: JSON.stringify({ limits, version }) });
      setLimits(result.limits); setVersion(result.version); setNotice('studio.settings.saved');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'studio.errors.request');
    } finally { setBusy(false); }
  }

  function change(key: LimitKey, field: 'limit' | 'seconds', value: string) {
    setLimits(current => current && { ...current, [key]: { ...current[key], [field]: Number(value) } });
  }

  return (
    <>
      <PageHeader eyebrow={t('studio.common.eyebrow')} title={t('studio.modules.settings')} description={t('studio.settings.description')} />
      <Notice>{error || notice}</Notice>
      <form className="studio-editor settings-editor" onSubmit={event => void save(event)}>
        <h2>
          <SettingsIcon size={20} />
          {t('studio.settings.chatTitle')}
        </h2>
        <p className="studio-help">{t('studio.settings.chatHelp')}</p>
        <p className="studio-help">{t('studio.settings.gatewayHelp')}</p>
        {!limits && !error && <Spinner label={t('studio.common.loading')} />}
        {limits && Object.keys(CHAT_LIMIT_DEFAULTS).map(name => {
          const key = name as LimitKey;
          return (
            <fieldset className="settings-limit" key={key}>
              <legend>{t(`studio.settings.${key}`)}</legend>
              <div className="form-grid">
                <label>
                  {t('studio.settings.requests')}
                  <input type="number" min="1" max="10000" step="1" required disabled={!canEdit || busy} value={limits[key].limit} onChange={event => change(key, 'limit', event.target.value)} />
                </label>
                <label>
                  {t('studio.settings.seconds')}
                  <input type="number" min="10" max="86400" step="1" required disabled={!canEdit || busy} value={limits[key].seconds} onChange={event => change(key, 'seconds', event.target.value)} />
                </label>
              </div>
            </fieldset>
          );
        })}
        {limits && canEdit && (
          <div className="modal-actions">
            <button className="button primary" disabled={busy}>
              {busy ? <Spinner label={t('studio.common.saving')} /> : t('studio.common.save')}
            </button>
          </div>
        )}
      </form>
    </>
  );
}
