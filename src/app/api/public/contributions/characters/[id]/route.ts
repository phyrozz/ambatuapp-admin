import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { adminDb } from "../../../../../../lib/firebase-admin";
import {
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  ContributionError,
  limitContribution,
} from "../../../../../../lib/community-content";
import { playerCharacterFields } from "../../../../../../lib/player-character";
import { verifyPlayerCharacterImage } from "../../../../../../lib/s3-images";

export const runtime = "nodejs";
export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const player = await contributionPlayer(request);
    const { id } = await context.params;
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new ContributionError(400);
    const body = await contributionBody(request);
    await limitContribution(player.id, "character-edit", 40);
    const ref = adminDb!.collection("characters").doc(id);
    await adminDb!.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (
        !existing.exists ||
        existing.data()?.uploaderId !== player.id ||
        existing.data()?.source !== "revamp"
      )
        throw new ContributionError(404);
      const existingImageKey = typeof existing.data()?.imageKey === 'string'
        ? existing.data()!.imageKey as string : null;
      const fields = playerCharacterFields(body, player.id, existingImageKey);
      if (fields.imageKey && fields.imageKey !== existingImageKey)
        await verifyPlayerCharacterImage(fields.imageKey);
      transaction.update(ref, {
        ...fields,
        updatedAt: FieldValue.serverTimestamp(),
        updated: "Just now",
      });
    });
    return NextResponse.json({ id }, { headers: contributionHeaders });
  } catch (error) {
    return contributionError(error);
  }
}
