import {
  deleteDreamComment,
  editDreamComment,
} from "../../../../../../../lib/dream-comments";
import {
  DreamError,
  validDreamId,
} from "../../../../../../../lib/dream-validation";
import {
  dreamViewer,
  readDreamBody,
  dreamResponse,
  dreamFailure,
  dreamOptions,
} from "../../../../../../../lib/dream-http";

export const OPTIONS = dreamOptions;
type Context = { params: Promise<{ id: string; commentId: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    const actor = (await dreamViewer(request, true))!;
    const { id, commentId } = await context.params;
    if (!validDreamId(id) || !validDreamId(commentId))
      throw new DreamError("COMMENT_UNAVAILABLE", 404);
    return dreamResponse(
      await editDreamComment(
        id,
        commentId,
        actor,
        await readDreamBody(request),
      ),
    );
  } catch (error) {
    return dreamFailure(error);
  }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const actor = (await dreamViewer(request, true))!;
    const { id, commentId } = await context.params;
    if (!validDreamId(id) || !validDreamId(commentId))
      throw new DreamError("COMMENT_UNAVAILABLE", 404);
    return dreamResponse(await deleteDreamComment(id, commentId, actor));
  } catch (error) {
    return dreamFailure(error);
  }
}
