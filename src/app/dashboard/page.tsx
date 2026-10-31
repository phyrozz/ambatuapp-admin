'use client';

import { useEffect, useState } from 'react';
import { Activity, CalendarPlus, RefreshCw, UsersRound } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { Notice, Spinner } from '../../components/admin-ui';
import { useI18n } from '../../components/studio-i18n';
import { studioApi } from '../../lib/studio-client';
import { DashboardInsights } from '../../components/dashboard-insights';

type DashboardData = {
  registered: number;
  newProfiles: number;
  activeDay: number;
  activeWeek: number;
  activeMonth: number;
  asOf: string;
  registrationTrend: { date: string; count: number }[];
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
    { key: 'registered', value: data.registered, icon: UsersRound },
    { key: 'newProfiles', value: data.newProfiles, icon: CalendarPlus },
    { key: 'activeDay', value: data.activeDay, icon: Activity },
    { key: 'activeWeek', value: data.activeWeek, icon: Activity },
    { key: 'activeMonth', value: data.activeMonth, icon: Activity },
  ] : [];

  const trend = data?.registrationTrend ?? [];
  const previousWeek = trend.slice(0, 7).reduce((sum, point) => sum + point.count, 0);
  const recentWeek = trend.slice(7).reduce((sum, point) => sum + point.count, 0);
  const maxCount = Math.max(1, ...trend.map(point => point.count));
  const change = previousWeek ? Math.round(((recentWeek - previousWeek) / previousWeek) * 100) : null;
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

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
          <p className="dashboard-updated">{t('studio.dashboard.updated', { time: new Date(data.asOf).toLocaleString(undefined, { timeZone: 'Asia/Manila', timeZoneName: 'short' }) })}</p>
          <div className="dashboard-grid">
            {metrics.map(({ key, value, icon: Icon }) => (
              <article className="dashboard-card" key={key}>
                <div className="dashboard-card-heading">
                  <span className="dashboard-icon">
                    <Icon size={20} />
                  </span>
                  <h2>{t(`studio.dashboard.${key}`)}</h2>
                </div>
                <strong>{value.toLocaleString()}</strong>
              </article>
            ))}
          </div>
          <div className="dashboard-insights">
            <section className="dashboard-panel dashboard-trend">
              <div className="dashboard-panel-heading">
                <div>
                  <h2>{t('studio.dashboard.registrationTrend')}</h2>
                  <p>{t('studio.dashboard.completedDays')}</p>
                </div>
                <div className="dashboard-comparison">
                  <strong>{recentWeek.toLocaleString()}</strong>
                  <span>{t('studio.dashboard.lastWeek')}</span>
                  <small>{change === null ? t(previousWeek === 0 && recentWeek === 0 ? 'studio.dashboard.noChange' : 'studio.dashboard.noBaseline') : t('studio.dashboard.change', { change: `${change > 0 ? '+' : ''}${change}%` })}</small>
                </div>
              </div>
              <div className="dashboard-chart" role="img" aria-label={t('studio.dashboard.chartLabel', { values: trend.map(point => `${dateLabel(point.date)}: ${point.count}`).join(', ') })}>
                {trend.map(point => (
                  <div className="dashboard-bar-column" key={point.date} title={`${dateLabel(point.date)}: ${point.count.toLocaleString()}`}>
                    <div className="dashboard-bar" style={{ height: `${Math.max(point.count ? 4 : 1, point.count / maxCount * 100)}%` }} />
                  </div>
                ))}
              </div>
              <div className="dashboard-chart-axis">
                <span>{trend[0] && dateLabel(trend[0].date)}</span>
                <span>{trend[trend.length - 1] && dateLabel(trend[trend.length - 1].date)}</span>
              </div>
            </section>
            <section className="dashboard-panel dashboard-engagement">
              <h2>{t('studio.dashboard.engagement')}</h2>
              <strong>{data.activeMonth ? `${Math.round(data.activeDay / data.activeMonth * 100)}%` : t('studio.dashboard.unavailable')}</strong>
              <p>{t('studio.dashboard.engagementHelp')}</p>
              <div className="dashboard-progress" aria-hidden="true">
                <span style={{ width: `${data.activeMonth ? data.activeDay / data.activeMonth * 100 : 0}%` }} />
              </div>
              <small>{t('studio.dashboard.activityShort')}</small>
            </section>
          </div>
          <DashboardInsights key={data.asOf} />
        </>
      )}
    </>
  );
}
