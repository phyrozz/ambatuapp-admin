import { createHash } from 'node:crypto';

export function normalizeCreatorQuery(value: string) {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

export function emailSearchKey(email: string) {
  return createHash('sha256').update(normalizeCreatorQuery(email)).digest('hex');
}

export function creatorSearchMode(query: string): 'email' | 'username' | null {
  if (query.includes('@')) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query) && query.length <= 254 ? 'email' : null;
  return query.length >= 2 && query.length <= 24 ? 'username' : null;
}
