export type CharacterListFilter = { query: string; status: 'Draft' | 'Published' | null; limit: number; owner: string | null };
export function characterListFilter(url: URL, owner: string | null): CharacterListFilter {
  const requested = Number(url.searchParams.get('limit')) || 30;
  const status = url.searchParams.get('status');
  return { query: (url.searchParams.get('q') ?? '').trim().toLowerCase(),
    status: status === 'Draft' || status === 'Published' ? status : null,
    limit: Math.min(50, Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 30))), owner };
}
export function parseCharacterListCursor(raw: string | null, filter: CharacterListFilter): string | null {
  if (!raw) return null;
  try {
    if (raw.length > 4096) throw new Error();
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: number; key?: string; id?: unknown };
    if (cursor.v !== 1 || cursor.key !== JSON.stringify(filter) || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 1500) throw new Error();
    return cursor.id;
  } catch { throw new Error('studio.errors.request'); }
}
export function encodeCharacterListCursor(id: string, filter: CharacterListFilter) {
  return Buffer.from(JSON.stringify({ v: 1, key: JSON.stringify(filter), id })).toString('base64url');
}
