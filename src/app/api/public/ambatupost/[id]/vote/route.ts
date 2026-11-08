import { voteDream } from "../../../../../../lib/dream-votes";
import {
  dreamIdempotencyKey,
  validDreamId,
  DreamError,
} from "../../../../../../lib/dream-validation";
import {
  dreamViewer,
  readDreamBody,
  dreamResponse,
  dreamFailure,
  dreamOptions,
} from "../../../../../../lib/dream-http";

export const OPTIONS = dreamOptions;
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const voter = (await dreamViewer(request, true))!;
    const { id } = await context.params;
    if (!validDreamId(id)) throw new DreamError("DREAM_UNAVAILABLE", 404);
    const key = dreamIdempotencyKey(request.headers.get("idempotency-key"));
    return dreamResponse(
      await voteDream(id, voter, await readDreamBody(request), key),
    );
  } catch (error) {
    return dreamFailure(error);
  }
}
