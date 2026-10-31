import { NextResponse } from 'next/server';
import { isDevCharacterWriter, isDevLoreWriter, isDevSoundWriter } from '../../../../../lib/dev-content-db';
import { soundInsights } from '../../../../../lib/dev-sounds';
import { characterInsights } from '../../../../../lib/dev-characters';
import { loreInsights } from '../../../../../lib/dev-lores';
import { requireContributionFirestore, contributionError, contributionHeaders, contributionPlayer } from '../../../../../lib/community-content';

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
    const usePostgresCharacters = isDevCharacterWriter();
    const usePostgresLores = isDevLoreWriter();
    const usePostgresSounds = isDevSoundWriter();
    const [lores, characters, sounds, postgresCharacters, postgresLores, postgresSounds] = await Promise.all([
      usePostgresLores ? Promise.resolve(null) : requireContributionFirestore().collection('lores').where('uploaderId', '==', player.id).get(),
      usePostgresCharacters ? Promise.resolve(null) : requireContributionFirestore().collection('characters').where('uploaderId', '==', player.id).get(),
      usePostgresSounds ? Promise.resolve(null) : requireContributionFirestore().collection('soundboardSounds').where('uploaderId', '==', player.id).get(),
      usePostgresCharacters ? characterInsights(player.id) : Promise.resolve(null),
      usePostgresLores ? loreInsights(player.id) : Promise.resolve(null),
      usePostgresSounds ? soundInsights(player.id) : Promise.resolve(null),
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

    for (const doc of lores?.docs ?? []) {
      const data = doc.data();
      if (data.source !== 'revamp') continue;
      if (data.status === 'Draft') insights.drafts += 1;
      else insights.published += 1;
      insights.loreViews += count(data.viewCount);
      insights.upvotes += count(data.upvotes);
      insights.downvotes += count(data.downvotes);
      insights.comments += count(data.commentCount);
    }
    if (postgresLores) {
      insights.drafts += postgresLores.drafts;
      insights.published += postgresLores.published;
      insights.loreViews += postgresLores.views;
      insights.upvotes += postgresLores.upvotes;
      insights.downvotes += postgresLores.downvotes;
      insights.comments += postgresLores.comments;
    }
    for (const doc of characters?.docs ?? []) {
      const data = doc.data();
      if (data.source !== 'revamp') continue;
      if (data.status === 'Draft') insights.drafts += 1;
      else insights.published += 1;
      insights.characterViews += count(data.viewCount);
    }
    if (postgresCharacters) {
      insights.drafts += postgresCharacters.drafts;
      insights.published += postgresCharacters.published;
      insights.characterViews += postgresCharacters.views;
    }
    for (const doc of sounds?.docs ?? []) {
      const data = doc.data();
      if (data.source !== 'revamp') continue;
      if (data.status === 'Draft') insights.drafts += 1;
      else insights.published += 1;
      insights.soundPlays += count(data.playCount);
      insights.soundListeners += count(data.listenerCount);
    }
    if (postgresSounds) {
      insights.drafts += postgresSounds.drafts;
      insights.published += postgresSounds.published;
      insights.soundPlays += postgresSounds.plays;
      insights.soundListeners += postgresSounds.listeners;
    }
    insights.views = insights.loreViews + insights.characterViews;

    return NextResponse.json(insights, { headers: contributionHeaders });
  } catch (error) {
    return contributionError(error);
  }
}
