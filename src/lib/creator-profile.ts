import type { Firestore } from 'firebase-admin/firestore';
import { profileAvatarUrl } from './profile-avatars';
import { isDevProfileWriter, isDevSocialWriter, isDevVideoWriter } from './dev-content-db';
import { getProfilePublic } from './dev-profiles';
import { creatorClipCount } from './dev-videos';
import { socialCounts } from './dev-social';

export const creatorHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

/** Explicit public allowlist: email, birthday, avatar keys and moderation records stay private. */
export async function creatorProfile(db: Firestore | null, id: string, viewerId: string) {
  if (!db) {
    if (!(isDevProfileWriter() && isDevSocialWriter() && isDevVideoWriter())) throw new Error('PROFILE_UNAVAILABLE');
    const profile = await getProfilePublic(id);
    if (!profile) throw new Error('PLAYER_NOT_FOUND');
    const own = id === viewerId;
    const [social, clipCount] = await Promise.all([socialCounts(id, viewerId), creatorClipCount(id, own)]);
    return { ...profile, followerCount: social.followers, friendCount: social.friends, clipCount,
      following: own ? false : social.following, friendState: own ? null : social.state };
  }
  const ref = db.collection('playerProfiles').doc(id);
  const useProfile = isDevProfileWriter();
  const profile = useProfile ? null : await ref.get();
  const pgProfile = useProfile ? await getProfilePublic(id) : null;
  if (useProfile ? !pgProfile : !profile?.exists) throw new Error('PLAYER_NOT_FOUND');
  const data = profile?.data() ?? {};
  const own = id === viewerId;
  const clips = db.collection('videos').where('uploaderId', '==', id);
  const useSocial = isDevSocialWriter();
  const [followers, friends, uploads, relationship, following, avatarUrl, social] = await Promise.all([
    useSocial ? null : ref.collection('followers').count().get(),
    useSocial ? null : ref.collection('friends').where('state', '==', 'accepted').count().get(),
    isDevVideoWriter() ? creatorClipCount(id, own) : (own ? clips : clips.where('status', '==', 'Published')).count().get().then(result => result.data().count),
    own || useSocial ? null : db.collection('playerProfiles').doc(viewerId).collection('friends').doc(id).get(),
    own || useSocial ? null : db.collection('playerProfiles').doc(viewerId).collection('following').doc(id).get(),
    useProfile ? pgProfile?.avatarUrl ?? null : profileAvatarUrl(typeof data.avatarKey === 'string' ? data.avatarKey : undefined),
    useSocial ? socialCounts(id, viewerId) : null,
  ]);
  return {
    id,
    username: useProfile ? pgProfile!.username : typeof data.username === 'string' ? data.username : '',
    bio: useProfile ? pgProfile!.bio : typeof data.bio === 'string' ? data.bio : '',
    avatarUrl,
    joinedAt: useProfile ? pgProfile!.joinedAt : data.createdAt?.toDate?.().toISOString() ?? null,
    followerCount: social?.followers ?? followers!.data().count,
    friendCount: social?.friends ?? friends!.data().count,
    clipCount: uploads,
    following: own ? false : social ? social.following : following?.exists === true,
    friendState: own ? null : social ? social.state : relationship?.data()?.state ?? null,
  };
}
