import { authorDreams } from "../../../../../../lib/dreams";
import { validFriendId } from "../../../../../../lib/friend-list";
import { DreamError } from "../../../../../../lib/dream-validation";
import {
  dreamViewer,
  dreamResponse,
  dreamFailure,
  dreamOptions,
} from "../../../../../../lib/dream-http";
export const OPTIONS = dreamOptions;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const viewer = await dreamViewer(request),
      { id } = await params;
    if (!validFriendId(id) || id === "admin")
      throw new DreamError("DREAM_UNAVAILABLE", 404);
    return dreamResponse(
      await authorDreams(
        id,
        viewer,
        new URL(request.url).searchParams.get("cursor"),
      ),
    );
  } catch (error) {
    return dreamFailure(error);
  }
}
