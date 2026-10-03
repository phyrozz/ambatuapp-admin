'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioApi } from '../lib/studio-client';
import { useI18n } from './studio-i18n';
import { Spinner } from './admin-ui';
export function useStudioList<T extends { id?: string; sub?: string }>(path: string) {
  const [items, setItems] = useState<T[]>([]), [cursor, setCursor] = useState<string | null>(null), [ready, setReady] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), resetRequested = useRef(false), generation = useRef(0), mounted = useRef(true), sentinel = useRef<HTMLDivElement>(null);
  const load = useCallback(async (reset = false): Promise<void> => {
    if (lock.current) { if (reset) resetRequested.current = true; return; }
    lock.current = true;
    const version = generation.current;
    setLoading(true); setError('');
    try {
      let replace = reset;
      do {
        resetRequested.current = false;
        const data = await studioApi(path + (!replace && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''));
        if (!mounted.current || version !== generation.current) return;
        const replaceBatch = replace;
        setItems(prior => {
          const merged = new Map((replaceBatch ? [] : prior).map(item => [item.id ?? item.sub, item]));
          for (const item of data.items ?? []) merged.set(item.id ?? item.sub, item);
          return [...merged.values()] as T[];
        });
        setCursor(data.nextCursor ?? null); setReady(true);
        replace = resetRequested.current;
      } while (replace && mounted.current);
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : 'studio.errors.request'); }
    finally {
      lock.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [path, cursor]);
  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void load(true), 0);
    return () => { mounted.current = false; window.clearTimeout(timer); };
    // Only initial load; subsequent batches use the current cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => {
    if (!ready || !cursor || loading || error || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(); }, { rootMargin: '300px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [ready, cursor, loading, error, load]);
  return { items, setItems, loading, error, sentinel, ready, cursor, load };
}
export function ListSentinel({ list }: { list: { sentinel: React.RefObject<HTMLDivElement | null>; loading: boolean; error: string; ready: boolean; cursor: string | null; load: (reset?: boolean) => Promise<void> } }) {
  // This object contains a DOM ref plus render state; only the ref is passed to React.
  const { sentinel, loading, error, ready, cursor, load } = list;
  const { t } = useI18n();
  return <div className="studio-list-sentinel" ref={sentinel}>{loading ? <Spinner label={t('studio.common.loading')}/> : error ? <><p role="alert">{t(error)}</p><button className="button ghost" onClick={() => void load(!ready)}>{t('studio.common.retry')}</button></> : ready && !cursor ? <small>{t('studio.common.noMore')}</small> : null}</div>;
}
