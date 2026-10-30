export type LoreCommentCursor = { v: 1; loreId: string; id: string; time: string | null };
export function encodeLoreCommentCursor(cursor: LoreCommentCursor) { return Buffer.from(JSON.stringify(cursor)).toString('base64url'); }
export function parseLoreCommentCursor(raw: string | null, loreId: string): LoreCommentCursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 4096) throw new Error();
    const cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as LoreCommentCursor;
    if (cursor.v !== 1 || cursor.loreId !== loreId || typeof cursor.id !== 'string' || !cursor.id || cursor.id.length > 1500
      || (cursor.time !== null && (typeof cursor.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}(?:\d{3})?Z$/.test(cursor.time) || !Number.isFinite(Date.parse(cursor.time))))) throw new Error();
    return cursor;
  } catch { throw new Error('Invalid comment cursor.'); }
}
