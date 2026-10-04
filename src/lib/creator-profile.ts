import type { Firestore } from 'firebase-admin/firestore';
import { profileAvatarUrl } from './profile-avatars';

export const creatorHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

/** Explicit public allowlist: email, birthday, avatar keys and moderation records stay private. */
export async function creatorProfile(db: Firestore, id: string, viewerId: string) {
  const ref = db.collection('playerProfiles').doc(id);
  const profile = await ref.get();
  if (!profile.exists) throw new Error('PLAYER_NOT_FOUND');
  const data = profile.data()!;
  const own = id === viewerId;
  const clips = db.collection('videos').where('uploaderId', '==', id);
  const [followers, friends, uploads, relationship, following, avatarUrl] = await Promise.all([
    ref.collection('followers').count().get(),
    ref.collection('friends').where('state', '==', 'accepted').count().get(),
    (own ? clips : clips.where('status', '==', 'Published')).count().get(),
    own ? null : db.collection('playerProfiles').doc(viewerId).collection('friends').doc(id).get(),
    own ? null : db.collection('playerProfiles').doc(viewerId).collection('following').doc(id).get(),
    profileAvatarUrl(typeof data.avatarKey === 'string' ? data.avatarKey : undefined),
  ]);
  return {
    id,
    username: typeof data.username === 'string' ? data.username : '',
    bio: typeof data.bio === 'string' ? data.bio : '',
    avatarUrl,
    joinedAt: data.createdAt?.toDate?.().toISOString() ?? null,
    followerCount: followers.data().count,
    friendCount: friends.data().count,
    clipCount: uploads.data().count,
    following: following?.exists === true,
    friendState: relationship?.data()?.state ?? null,
  };
}
