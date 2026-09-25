import { adminDb } from './firebase-admin';
import { profileAvatarUrl } from './profile-avatars';

export type PlayerProfile = { username: string; birthDate: string | null };
export type PlayerDisplayProfile = { username: string; avatarUrl: string | null };

export function fallbackPlayerName(email: string) {
  return email.split('@')[0] || 'Player';
}

export async function playerNames(ids: readonly string[], fallback: ReadonlyMap<string, string>) {
  const profiles = await playerDisplayProfiles(ids, fallback);
  return new Map([...profiles].map(([id, profile]) => [id, profile.username]));
}

export async function playerDisplayProfiles(ids: readonly string[], fallback: ReadonlyMap<string, string>) {
  const db = adminDb;
  if (!db || !ids.length) return new Map<string, PlayerDisplayProfile>();
  const unique = [...new Set(ids)];
  const docs = await db.getAll(...unique.map((id) => db.collection('playerProfiles').doc(id)));
  const results = await Promise.all(docs.map(async (doc, index) => {
    const data = doc.data() ?? {};
    const id = unique[index];
    return [id, {
      username: typeof data.username === 'string' && data.username ? data.username : fallbackPlayerName(fallback.get(id) ?? ''),
      avatarUrl: await profileAvatarUrl(typeof data.avatarKey === 'string' ? data.avatarKey : undefined),
    }] as const;
  }));
  return new Map(results);
}
