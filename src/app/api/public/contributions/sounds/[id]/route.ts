import { FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { isDevSoundWriter } from "../../../../../../lib/dev-content-db";
import { deleteCreatorSound, editCreatorSound } from "../../../../../../lib/dev-sounds";
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
import { soundFields } from "../../../../../../lib/admin-sounds";
import {
  adminSoundUploadKey,
  deleteSoundUpload,
  verifySoundUpload,
  signedSoundUrl,
} from "../../../../../../lib/s3-sounds";

export const runtime = "nodejs";

export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

function validId(id: string) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    id,
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const player = await contributionPlayer(request);
    const { id } = await params;
    if (!validId(id)) throw new ContributionError(404);
    const body = await contributionBody(request);
    const requestedStatus = body.status === undefined ? undefined : contributionStatus(body.status);
    const fields = soundFields(body);
    await limitContribution(player.id, "sound-edit", 30);
    if (isDevSoundWriter()) return NextResponse.json(await editCreatorSound(player.id, id, fields, requestedStatus, body.soundKey), { headers: contributionHeaders });
    const ref = adminDb!.collection("soundboardSounds").doc(id);
    const current = await ref.get();
    const data = current.data();
    if (
      !current.exists ||
      !data ||
      data.uploaderId !== player.id ||
      data.source !== "revamp"
    )
      throw new ContributionError(404);
    const oldSoundKey = adminSoundUploadKey(
      data.soundKey,
      `player_${player.id}`,
    );
    if (body.soundKey !== undefined && typeof body.soundKey !== "string")
      throw new ContributionError(400);
    const soundKey =
      body.soundKey === undefined
        ? oldSoundKey
        : adminSoundUploadKey(body.soundKey, `player_${player.id}`);
    if (soundKey !== oldSoundKey) await verifySoundUpload(soundKey);
    let status: 'Draft' | 'Published' = 'Published';
    await adminDb!.runTransaction(async (transaction) => {
      const latest = await transaction.get(ref);
      const latestData = latest.data();
      if (
        !latest.exists ||
        !latestData ||
        latestData.uploaderId !== player.id ||
        latestData.source !== "revamp"
      )
        throw new ContributionError(404);
      if (
        adminSoundUploadKey(latestData.soundKey, `player_${player.id}`) !==
        oldSoundKey
      )
        throw new ContributionError(409);
      status = requestedStatus ?? (latestData.status === 'Draft' ? 'Draft' : 'Published');
      transaction.update(ref, {
        ...fields,
        status,
        soundKey,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    if (soundKey !== oldSoundKey)
      await deleteSoundUpload(oldSoundKey).catch(() => undefined);
    return NextResponse.json(
      { sound: { id, ...fields, status, file: await signedSoundUrl(soundKey) } },
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
    if (!validId(id)) throw new ContributionError(404);
    await limitContribution(player.id, "sound-delete", 30);
    if (isDevSoundWriter()) {
      await deleteCreatorSound(player.id, id);
      return NextResponse.json({ deleted: true }, { headers: contributionHeaders });
    }
    const ref = adminDb!.collection("soundboardSounds").doc(id);
    let soundKey = "";
    await adminDb!.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      const data = existing.data();
      if (
        !existing.exists ||
        !data ||
        data.uploaderId !== player.id ||
        data.source !== "revamp"
      )
        throw new ContributionError(404);
      soundKey = adminSoundUploadKey(data.soundKey, `player_${player.id}`);
      transaction.delete(ref);
    });
    await deleteSoundUpload(soundKey).catch(() => undefined);
    return NextResponse.json(
      { deleted: true },
      { headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}
