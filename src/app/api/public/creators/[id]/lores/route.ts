import { NextResponse } from "next/server";
import {
  publicCreatorViewer,
  creatorPublishedLores,
} from "../../../../../../lib/public-creator-content";
import { creatorHeaders as headers } from "../../../../../../lib/creator-profile";
export function OPTIONS() {
  return new NextResponse(null, { headers });
}
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await publicCreatorViewer(request, id);
    return NextResponse.json(
      await creatorPublishedLores(
        id,
        new URL(request.url).searchParams.get("cursor"),
      ),
      { headers },
    );
  } catch (error) {
    const status = (error as { status?: number }).status ?? 503;
    return NextResponse.json(
      {
        error:
          status === 404
            ? "PLAYER_NOT_FOUND"
            : status === 401
              ? "UNAUTHORIZED"
              : status === 400
                ? "INVALID_CURSOR"
                : "UNAVAILABLE",
      },
      { status, headers },
    );
  }
}
