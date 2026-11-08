import { listDreamFeed } from "../../../../../lib/dream-feed";
import {
  dreamViewer,
  dreamResponse,
  dreamFailure,
  dreamOptions,
} from "../../../../../lib/dream-http";
export const OPTIONS = dreamOptions;
export async function GET(request: Request) {
  const start = performance.now();
  try {
    const viewer = await dreamViewer(request);
    const result = await listDreamFeed(
      viewer,
      new URL(request.url).searchParams.get("cursor"),
    );
    const durationMs=performance.now()-start;
    // Sample aggregate outcomes only: never log viewers, IDs, text, votes or cursor values.
    if(Math.random()<.01)console.info('DREAM_FEED_PAGE',{
      durationMs:Math.round(durationMs),returned:result.dreams.length,
      authors:new Set(result.dreams.map(dream=>dream.authorId)).size,
      hasMore:Boolean(result.nextCursor),
    });
    const response = dreamResponse(result);
    response.headers.set(
      "Server-Timing",
      `dream-feed;dur=${durationMs.toFixed(1)}`,
    );
    return response;
  } catch (error) {
    return dreamFailure(error);
  }
}
