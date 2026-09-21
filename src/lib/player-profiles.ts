import { adminDb } from './firebase-admin';

export type PlayerProfile = { username: string; birthDate: string | null };

export function fallbackPlayerName(email: string) {
  return email.split('@')[0] || 'Player';
}

export async function playerNames(ids: readonly string[], fallback: ReadonlyMap<string, string>) {
  const db = adminDb;
  if (!db || !ids.length) return new Map<string, string>();
  const unique = [...new Set(ids)];
  const docs = await db.getAll(...unique.map((id) => db.collection('playerProfiles').doc(id)));
  return new Map(docs.map((doc, index) => {
    const username = doc.data()?.username;
    return [unique[index], typeof username === 'string' && username ? username : fallbackPlayerName(fallback.get(unique[index]) ?? '')];
  }));
}
