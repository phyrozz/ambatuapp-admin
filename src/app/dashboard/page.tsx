'use client';

import { useEffect, useState } from 'react';
import { Activity, CalendarPlus, RefreshCw, UsersRound } from 'lucide-react';
import { AdminShell, PageHeader } from '../../components/admin-shell';
import { Notice, Spinner } from '../../components/admin-ui';
import { useI18n } from '../../components/studio-i18n';
import { studioApi } from '../../lib/studio-client';
import { DashboardInsights } from '../../components/dashboard-insights';
import { DashboardTrendChart } from '../../components/dashboard-trend-chart';

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
  const completedTrend = trend.slice(0, -1);
  const previousWeek = completedTrend.slice(0, 7).reduce((sum, point) => sum + point.count, 0);
  const recentWeek = completedTrend.slice(7).reduce((sum, point) => sum + point.count, 0);
  const change = previousWeek ? Math.round(((recentWeek - previousWeek) / previousWeek) * 100) : null;

  return (
    <>
      <PageHeader
        eyebrow={t('studio.common.eyebrow')}
        title={t('studio.modules.dashboard')}
        action={(
          <button type="button" className="button ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Spinner label={t('studio.common.loading')} /> : <RefreshCw size={16} />}
            {t('studio.common.refresh')}
          </button>
        )}
      />
      <Notice>{error}</Notice>
      {loading && !data && <DashboardLoadingSkeleton label={t('studio.common.loading')} />}
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
              <DashboardTrendChart points={trend} ongoingDate={trend[trend.length - 1]?.date} label={t('studio.dashboard.registrationTrend')} pointLabel="studio.dashboard.profilePoint" />
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

function DashboardLoadingSkeleton({ label }: { label: string }) {
  return (
    <div className="dashboard-skeleton" role="status" aria-label={label} aria-busy="true">
      <div className="dashboard-grid" aria-hidden="true">
        {Array.from({ length: 5 }, (_, index) => (
          <article className="dashboard-card" key={index}>
            <div className="dashboard-card-heading">
              <span className="dashboard-skeleton-block dashboard-skeleton-icon" />
              <span className="dashboard-skeleton-block dashboard-skeleton-heading" />
            </div>
            <span className="dashboard-skeleton-block dashboard-skeleton-number" />
          </article>
        ))}
      </div>
      <div className="dashboard-insights" aria-hidden="true">
        <section className="dashboard-panel dashboard-trend dashboard-skeleton-trend">
          <div className="dashboard-panel-heading">
            <div className="dashboard-skeleton-copy">
              <span className="dashboard-skeleton-block dashboard-skeleton-title" />
              <span className="dashboard-skeleton-block dashboard-skeleton-subtitle" />
            </div>
            <div className="dashboard-skeleton-copy dashboard-skeleton-align-end">
              <span className="dashboard-skeleton-block dashboard-skeleton-comparison" />
              <span className="dashboard-skeleton-block dashboard-skeleton-subtitle" />
            </div>
          </div>
          <span className="dashboard-skeleton-block dashboard-skeleton-chart" />
        </section>
        <section className="dashboard-panel dashboard-engagement dashboard-skeleton-engagement">
          <span className="dashboard-skeleton-block dashboard-skeleton-title" />
          <span className="dashboard-skeleton-block dashboard-skeleton-engagement-value" />
          <span className="dashboard-skeleton-block dashboard-skeleton-subtitle" />
          <span className="dashboard-skeleton-block dashboard-skeleton-progress" />
          <span className="dashboard-skeleton-block dashboard-skeleton-subtitle" />
        </section>
      </div>
    </div>
  );
}
