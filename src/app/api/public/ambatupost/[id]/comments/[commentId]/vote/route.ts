import { voteDreamComment } from "../../../../../../../../lib/dream-comments";
import {
  DreamError,
  dreamIdempotencyKey,
  validDreamId,
} from "../../../../../../../../lib/dream-validation";
import {
  dreamViewer,
  readDreamBody,
  dreamResponse,
  dreamFailure,
  dreamOptions,
} from "../../../../../../../../lib/dream-http";

export const OPTIONS = dreamOptions;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; commentId: string }> },
) {
  try {
    const actor = (await dreamViewer(request, true))!;
    const { id, commentId } = await context.params;
    if (!validDreamId(id) || !validDreamId(commentId))
      throw new DreamError("COMMENT_UNAVAILABLE", 404);
    const key = dreamIdempotencyKey(request.headers.get("idempotency-key"));
    return dreamResponse(
      await voteDreamComment(
        id,
        commentId,
        actor,
        await readDreamBody(request),
        key,
      ),
    );
  } catch (error) {
    return dreamFailure(error);
  }
}
