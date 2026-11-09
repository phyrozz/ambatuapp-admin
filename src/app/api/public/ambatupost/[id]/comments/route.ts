import {
  createDreamComment,
  listDreamComments,
} from "../../../../../../lib/dream-comments";
import {
  DreamError,
  dreamIdempotencyKey,
  validDreamId,
} from "../../../../../../lib/dream-validation";
import {
  dreamViewer,
  readDreamBody,
  dreamResponse,
  dreamFailure,
  dreamOptions,
} from "../../../../../../lib/dream-http";

export const OPTIONS = dreamOptions;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const viewer = await dreamViewer(request);
    const { id } = await context.params;
    if (!validDreamId(id)) throw new DreamError("DREAM_UNAVAILABLE", 404);
    const query = new URL(request.url).searchParams;
    return dreamResponse(
      await listDreamComments(
        id,
        viewer,
        query.get("cursor"),
        query.get("parent"),
      ),
    );
  } catch (error) {
    return dreamFailure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const actor = (await dreamViewer(request, true))!;
    const { id } = await context.params;
    if (!validDreamId(id)) throw new DreamError("DREAM_UNAVAILABLE", 404);
    const key = dreamIdempotencyKey(request.headers.get("idempotency-key"));
    return dreamResponse(
      await createDreamComment(id, actor, await readDreamBody(request), key),
      201,
    );
  } catch (error) {
    return dreamFailure(error);
  }
}
