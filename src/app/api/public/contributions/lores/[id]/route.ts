import { FieldValue } from "firebase-admin/firestore";
import { isDevLoreWriter } from "../../../../../../lib/dev-content-db";
import { deleteCreatorLore, editCreatorLore } from "../../../../../../lib/dev-lores";
import { NextResponse } from "next/server";
import { adminDb } from "../../../../../../lib/firebase-admin";
import {
  ContributionError,
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  contributionStatus,
  limitContribution,
} from "../../../../../../lib/community-content";
import {
  deleteCharacterImage,
  isPlayerLoreImageKey,
  signedCharacterImageUrl,
  verifyPlayerLoreImage,
} from "../../../../../../lib/s3-images";
import { loreFields } from "../../../../../../lib/community-contribution-validation";

export const runtime = "nodejs";

export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const player = await contributionPlayer(request);
    const { id } = await params;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new ContributionError(404);
    const body = await contributionBody(request);
    const requestedStatus = body.status === undefined ? undefined : contributionStatus(body.status);
    const fields = loreFields(body, player.id);
    await limitContribution(player.id, "lore-edit", 30);
    await Promise.all(fields.imageKeys.map(verifyPlayerLoreImage));
    if (isDevLoreWriter()) return NextResponse.json(await editCreatorLore(player.id, id, fields, requestedStatus), { headers: contributionHeaders });
    const ref = adminDb!.collection("lores").doc(id);
    let oldImages: string[] = [];
    let status: 'Draft' | 'Published' = 'Published';
    await adminDb!.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      const data = existing.data();
      if (
        !existing.exists ||
        data?.uploaderId !== player.id ||
        data?.source !== "revamp"
      )
        throw new ContributionError(404);
      oldImages = Array.isArray(data.imageKeys)
        ? data.imageKeys.filter((key): key is string => typeof key === "string")
        : [];
      status = requestedStatus ?? (data.status === 'Draft' ? 'Draft' : 'Published');
      transaction.update(ref, {
        ...fields,
        status,
        updatedAt: FieldValue.serverTimestamp(),
        updated: "Just now",
      });
    });
    const retained = new Set(fields.imageKeys);
    await Promise.allSettled(
      oldImages
        .filter(
          (key) => !retained.has(key) && isPlayerLoreImageKey(key, player.id),
        )
        .map(deleteCharacterImage),
    );
    const imageUrls = await Promise.all(
      fields.imageKeys.map(
        async (key) => (await signedCharacterImageUrl(key)) ?? "",
      ),
    );
    return NextResponse.json(
      { lore: { id, ...fields, status, imageUrls } },
      { headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const player = await contributionPlayer(request);
    const { id } = await params;
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new ContributionError(404);
    await limitContribution(player.id, "lore-delete", 30);
    if (isDevLoreWriter()) {
      await deleteCreatorLore(player.id, id);
      return NextResponse.json({ deleted: true }, { headers: contributionHeaders });
    }
    const ref = adminDb!.collection("lores").doc(id);
    let imageKeys: string[] = [];
    await adminDb!.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      const data = existing.data();
      if (
        !existing.exists ||
        data?.uploaderId !== player.id ||
        data?.source !== "revamp"
      )
        throw new ContributionError(404);
      imageKeys = Array.isArray(data.imageKeys)
        ? data.imageKeys.filter((key): key is string =>
            isPlayerLoreImageKey(key, player.id),
          )
        : [];
      transaction.delete(ref);
    });
    await Promise.allSettled(imageKeys.map(deleteCharacterImage));
    return NextResponse.json(
      { deleted: true },
      { headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}
