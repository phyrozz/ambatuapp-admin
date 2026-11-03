'use client';

import { useRef, useState } from 'react';
import { useI18n } from './studio-i18n';

type Point = { date: string; count: number };

export function DashboardTrendChart({ points, ongoingDate, label, pointLabel }: { points: Point[]; ongoingDate?: string; label: string; pointLabel: string }) {
  const { t } = useI18n();
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  if (!points.length) return null;

  const selectedIndex = Math.max(0, points.findIndex(point => point.date === selectedDate));
  const activeIndex = selectedDate === null || !points.some(point => point.date === selectedDate) ? points.length - 1 : selectedIndex;
  const shown = points.find(point => point.date === hoveredDate) ?? points[activeIndex];
  const max = Math.max(1, ...points.map(point => point.count));
  const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const ongoingLabel = t('studio.dashboard.todayInProgress');
  const description = (point: Point) => {
    const label = t(pointLabel, { date: dateLabel(point.date), count: point.count.toLocaleString() });
    return point.date === ongoingDate ? `${label}. ${ongoingLabel}` : label;
  };

  function moveSelection(index: number) {
    const next = Math.max(0, Math.min(points.length - 1, index));
    setSelectedDate(points[next].date);
    setHoveredDate(null);
    buttons.current[next]?.focus();
  }

  return (
    <div className="dashboard-chart-wrap">
      <div className="dashboard-chart-readout" aria-hidden="true">
        <span>
          {dateLabel(shown.date)}
          {shown.date === ongoingDate && <small className="dashboard-chart-ongoing-label">{ongoingLabel}</small>}
        </span>
        <strong>{shown.count.toLocaleString()}</strong>
      </div>
      <div className="dashboard-chart" role="radiogroup" aria-label={label} onPointerLeave={() => setHoveredDate(null)}>
        {points.map((point, index) => (
          <button
            className={`dashboard-bar-column${point.date === ongoingDate ? ' dashboard-bar-column-ongoing' : ''}`}
            key={point.date}
            type="button"
            role="radio"
            aria-checked={index === activeIndex}
            aria-label={description(point)}
            tabIndex={index === activeIndex ? 0 : -1}
            ref={element => { buttons.current[index] = element; }}
            onPointerEnter={event => { if (event.pointerType === 'mouse') setHoveredDate(point.date); }}
            onFocus={() => setSelectedDate(point.date)}
            onClick={() => { setSelectedDate(point.date); setHoveredDate(null); }}
            onKeyDown={event => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(index + 1); }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(index - 1); }
              if (event.key === 'Home') { event.preventDefault(); moveSelection(0); }
              if (event.key === 'End') { event.preventDefault(); moveSelection(points.length - 1); }
            }}
          >
            <span className="dashboard-bar" style={{ height: `${Math.max(point.count ? 4 : 1, point.count / max * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="dashboard-chart-axis" aria-hidden="true">
        <span>{dateLabel(points[0].date)}</span>
        <span>
          {dateLabel(points[points.length - 1].date)}
          {points[points.length - 1].date === ongoingDate && <small className="dashboard-chart-ongoing-label">{ongoingLabel}</small>}
        </span>
      </div>
    </div>
  );
}
