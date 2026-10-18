import { NextResponse } from 'next/server';
import { adminDb } from '../../../../../lib/firebase-admin';
import { contributionError, contributionHeaders, contributionPlayer } from '../../../../../lib/community-content';

export const runtime = 'nodejs';

export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function GET(request: Request) {
  try {
    const player = await contributionPlayer(request);
    const [lores, characters, sounds] = await Promise.all([
      adminDb!.collection('lores').where('uploaderId', '==', player.id).get(),
      adminDb!.collection('characters').where('uploaderId', '==', player.id).get(),
      adminDb!.collection('soundboardSounds').where('uploaderId', '==', player.id).get(),
    ]);

    const insights = {
      views: 0,
      loreViews: 0,
      characterViews: 0,
      soundPlays: 0,
      soundListeners: 0,
      upvotes: 0,
      downvotes: 0,
      comments: 0,
      published: 0,
      drafts: 0,
    };

    for (const doc of lores.docs) {
      const data = doc.data();
      if (data.source !== 'revamp') continue;
      if (data.status === 'Draft') insights.drafts += 1;
      else insights.published += 1;
      insights.loreViews += count(data.viewCount);
      insights.upvotes += count(data.upvotes);
      insights.downvotes += count(data.downvotes);
      insights.comments += count(data.commentCount);
    }
    for (const doc of characters.docs) {
      const data = doc.data();
      if (data.source !== 'revamp') continue;
      if (data.status === 'Draft') insights.drafts += 1;
      else insights.published += 1;
      insights.characterViews += count(data.viewCount);
    }
    for (const doc of sounds.docs) {
      const data = doc.data();
      if (data.source !== 'revamp') continue;
      if (data.status === 'Draft') insights.drafts += 1;
      else insights.published += 1;
      insights.soundPlays += count(data.playCount);
      insights.soundListeners += count(data.listenerCount);
    }
    insights.views = insights.loreViews + insights.characterViews;

    return NextResponse.json(insights, { headers: contributionHeaders });
  } catch (error) {
    return contributionError(error);
  }
}
