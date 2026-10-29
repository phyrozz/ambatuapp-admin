'use client';

import { useEffect, useState } from 'react';
import { Activity, CalendarPlus, RefreshCw, UsersRound } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { Notice, Spinner } from '../../components/admin-ui';
import { useI18n } from '../../components/studio-i18n';
import { studioApi } from '../../lib/studio-client';

type DashboardData = {
  registered: number;
  newProfiles: number;
  activeDay: number;
  activeWeek: number;
  activeMonth: number;
  asOf: string;
};

export default function DashboardPage() {
  return (
    <AdminShell>
      <Dashboard />
    </AdminShell>
  );
}

function Dashboard() {
  const { t } = useI18n();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setData(await studioApi('/api/dashboard') as DashboardData);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'studio.errors.request');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    studioApi('/api/dashboard').then(result => {
      if (active) setData(result as DashboardData);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : 'studio.errors.request');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const metrics = data ? [
    { key: 'registered', value: data.registered, help: 'registeredHelp', icon: UsersRound },
    { key: 'newProfiles', value: data.newProfiles, help: 'newProfilesHelp', icon: CalendarPlus },
    { key: 'activeDay', value: data.activeDay, help: 'activeHelp', icon: Activity },
    { key: 'activeWeek', value: data.activeWeek, help: 'activeHelp', icon: Activity },
    { key: 'activeMonth', value: data.activeMonth, help: 'activeHelp', icon: Activity },
  ] : [];

  return (
    <>
      <PageHeader
        eyebrow={t('studio.common.eyebrow')}
        title={t('studio.modules.dashboard')}
        action={(
          <button type="button" className="button ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={16} />
            {t('studio.common.refresh')}
          </button>
        )}
      />
      <Notice>{error}</Notice>
      {loading && !data && <Spinner label={t('studio.common.loading')} />}
      {data && (
        <>
          <p className="dashboard-updated">{t('studio.dashboard.updated', { time: new Date(data.asOf).toLocaleString() })}</p>
          <div className="dashboard-grid">
            {metrics.map(({ key, value, help, icon: Icon }) => (
              <article className="dashboard-card" key={key}>
                <div className="dashboard-card-heading">
                  <span className="dashboard-icon">
                    <Icon size={20} />
                  </span>
                  <h2>{t(`studio.dashboard.${key}`)}</h2>
                </div>
                <strong>{value.toLocaleString()}</strong>
                <p>{t(`studio.dashboard.${help}`)}</p>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
