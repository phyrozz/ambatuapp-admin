'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useI18n } from './studio-i18n';
import { studioApi } from '../lib/studio-client';

type Kind = 'character' | 'lore' | 'video' | 'sound';
type Counts = { kind: Kind; published: number; draft: number; other: number; trend: number[] };
type Period = { previous: number; recent: number };
type Insights = { restricted?: boolean; content: (Counts | null)[]; top: ({ kind: Kind; title: string | null; votes: number }[] | null)[]; comments: Period | null; follows: Period | null; avatars: number | null; reports: number | null; dates: string[] };
const urls: Record<Kind, string> = { character: '/', lore: '/lores', video: '/videos', sound: '/sounds' };

export function DashboardInsights() {
  const { t } = useI18n();
  const [data, setData] = useState<Insights | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    studioApi('/api/dashboard/insights').then(result => {
      if (active) setData(result as Insights);
    }).catch(() => {
      if (active) setFailed(true);
    });
    return () => { active = false; };
  }, []);
  if (failed) return <p className="dashboard-insight-status">{t('studio.dashboard.insightsUnavailable')}</p>;
  if (!data || data.restricted) return null;
  const content = data.content.filter((item): item is Counts => item !== null);
  const complete = data.content.every(Boolean) && data.content.length === 4;
  const trend = data.dates.map((date, i) => ({ date, count: content.reduce((sum, item) => sum + item.trend[i], 0) }));
  const max = Math.max(1, ...trend.map(item => item.count));
  const previous = trend.slice(0, 7).reduce((sum, item) => sum + item.count, 0);
  const recent = trend.slice(7).reduce((sum, item) => sum + item.count, 0);
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const top = data.top.flatMap(item => item ?? []).sort((a, b) => b.votes - a.votes).slice(0, 5);
  const partialTop = data.top.length !== 3 || data.top.some(item => item === null);
  const period = (value: Period | null) => value ? `${value.recent.toLocaleString()} / ${value.previous.toLocaleString()}` : t('studio.dashboard.unavailable');
  return (
    <div className="dashboard-extra">
      <section className="dashboard-panel">
        <div className="dashboard-panel-heading">
          <div>
            <h2>{t('studio.dashboard.contentOverview')}</h2>
            <p>{t('studio.dashboard.contentColumns')}</p>
          </div>
        </div>
        <div className="dashboard-content-list">
          {content.map(item => (
            <Link href={urls[item.kind]} className="dashboard-content-row" key={item.kind}>
              <span>{t(`studio.dashboard.kind.${item.kind}`)}</span>
              <strong>{item.published.toLocaleString()} / {item.draft.toLocaleString()}</strong>
              {item.other > 0 && <small>{t('studio.dashboard.otherCount', { count: item.other })}</small>}
            </Link>
          ))}
          {data.content.some(item => item === null) && <small>{t('studio.dashboard.someUnavailable')}</small>}
        </div>
      </section>
      <section className="dashboard-panel dashboard-trend">
        <div className="dashboard-panel-heading">
          <div>
            <h2>{t('studio.dashboard.contentTrend')}</h2>
            <p>{t('studio.dashboard.completedDays')}</p>
          </div>
          {complete && (
            <div className="dashboard-comparison">
              <strong>{recent.toLocaleString()}</strong>
              <span>{t('studio.dashboard.lastWeek')}</span>
              <small>{previous ? t('studio.dashboard.change', { change: `${Math.round((recent - previous) / previous * 100) > 0 ? '+' : ''}${Math.round((recent - previous) / previous * 100)}%` }) : t(recent ? 'studio.dashboard.noBaseline' : 'studio.dashboard.noChange')}</small>
            </div>
          )}
        </div>
        {complete ? (
          <>
            <div className="dashboard-chart" role="img" aria-label={t('studio.dashboard.contentChartLabel', { values: trend.map(item => `${dateLabel(item.date)}: ${item.count}`).join(', ') })}>
              {trend.map(item => (
                <div className="dashboard-bar-column" key={item.date} title={`${dateLabel(item.date)}: ${item.count}`}>
                  <div className="dashboard-bar" style={{ height: `${Math.max(item.count ? 4 : 1, item.count / max * 100)}%` }} />
                </div>
              ))}
            </div>
            <div className="dashboard-chart-axis">
              <span>{trend[0] && dateLabel(trend[0].date)}</span>
              <span>{trend.at(-1) && dateLabel(trend.at(-1)!.date)}</span>
            </div>
          </>
        ) : <p className="dashboard-empty-label">{t('studio.dashboard.unavailable')}</p>}
      </section>
      <section className="dashboard-panel">
        <div className="dashboard-panel-heading">
          <div>
            <h2>{t('studio.dashboard.popular')}</h2>
            <p>{t('studio.dashboard.popularHelp')}</p>
          </div>
        </div>
        <div className="dashboard-content-list">
          {top.map((item, i) => (
            <Link href={urls[item.kind]} className="dashboard-content-row" key={`${item.kind}-${i}`}>
              <span className="dashboard-popular-title">{item.title || t('studio.dashboard.untitled')} <small>{t(`studio.dashboard.kind.${item.kind}`)}</small></span>
              <strong>{item.votes.toLocaleString()}</strong>
            </Link>
          ))}
          {!top.length && <small>{t(partialTop ? 'studio.dashboard.unavailable' : 'studio.dashboard.noPopular')}</small>}
          {top.length > 0 && partialTop && <small>{t('studio.dashboard.someUnavailable')}</small>}
        </div>
      </section>
      <section className="dashboard-panel">
        <h2>{t('studio.dashboard.community')}</h2>
        <p className="dashboard-panel-subtitle">{t('studio.dashboard.periods')}</p>
        <div className="dashboard-content-list">
          <div className="dashboard-content-row">
            <span>{t('studio.dashboard.comments')}</span>
            <strong>{period(data.comments)}</strong>
          </div>
          <div className="dashboard-content-row">
            <span>{t('studio.dashboard.follows')}</span>
            <strong>{period(data.follows)}</strong>
          </div>
        </div>
        <small className="dashboard-footnote">{t('studio.dashboard.communityHelp')}</small>
      </section>
      <section className="dashboard-panel">
        <h2>{t('studio.dashboard.moderation')}</h2>
        <div className="dashboard-content-list">
          <Link href="/chat-reports" className="dashboard-content-row">
            <span>{t('studio.dashboard.openReports')}</span>
            <strong>{data.reports === null ? t('studio.dashboard.unavailable') : data.reports.toLocaleString()}</strong>
          </Link>
          <Link href="/profile-avatars" className="dashboard-content-row">
            <span>{t('studio.dashboard.pendingAvatars')}</span>
            <strong>{data.avatars === null ? t('studio.dashboard.unavailable') : data.avatars.toLocaleString()}</strong>
          </Link>
        </div>
      </section>
    </div>
  );
}
