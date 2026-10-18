import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { NextResponse } from "next/server";
import { adminDb } from "../../../../../lib/firebase-admin";
import {
  ContributionError,
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  contributionStatus,
  limitContribution,
} from "../../../../../lib/community-content";
import { soundAudioUrl, soundFields } from "../../../../../lib/admin-sounds";
import {
  adminSoundUploadKey,
  verifySoundUpload,
  signedSoundUrl,
} from "../../../../../lib/s3-sounds";

export const runtime = "nodejs";
export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

export async function GET(request: Request) {
  try {
    const player = await contributionPlayer(request);
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit")) || 20;
    const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
    const collection = adminDb!.collection("soundboardSounds");
    const cursorValue = url.searchParams.get("cursor");
    let cursorId: string | null = null;
    if (cursorValue) {
      try {
        cursorId = Buffer.from(cursorValue, "base64url").toString("utf8");
        if (
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
            cursorId,
          )
        )
          throw new Error();
      } catch {
        throw new ContributionError(400);
      }
    }
    let query = collection
      .where("uploaderId", "==", player.id)
      .where("source", "==", "revamp")
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc")
      .limit(limit + 1);
    if (cursorId) {
      const cursor = await collection.doc(cursorId).get();
      if (
        !cursor.exists ||
        cursor.data()?.uploaderId !== player.id ||
        cursor.data()?.source !== "revamp"
      )
        throw new ContributionError(400);
      query = query.startAfter(cursor);
    }
    const snapshot = await query.get();
    const page = snapshot.docs.slice(0, limit);
    const owner = `player_${player.id}`;
    const sounds = (await Promise.all(page.map(async (doc) => {
      const data = doc.data();
      try {
        adminSoundUploadKey(data.soundKey, owner);
        if (typeof data.name !== "string" || typeof data.category !== "string")
          return null;
        return (
          {
            id: doc.id,
            status: data.status === 'Draft' ? 'Draft' : 'Published',
            name: data.name,
            category: data.category,
            playCount: typeof data.playCount === 'number' && Number.isSafeInteger(data.playCount) && data.playCount > 0 ? data.playCount : 0,
            listenerCount: typeof data.listenerCount === 'number' && Number.isSafeInteger(data.listenerCount) && data.listenerCount > 0 ? data.listenerCount : 0,
            file: data.status === 'Draft' ? await signedSoundUrl(data.soundKey) : soundAudioUrl(new URL(request.url).origin, doc.id),
            createdAt:
              (data.createdAt as { toDate?: () => Date } | undefined)
                ?.toDate?.()
                .toISOString() ?? null,
          }
        );
      } catch {
        return null;
      }
    }))).filter((sound) => sound !== null);
    const last = page.at(-1);
    const nextCursor =
      snapshot.docs.length > limit && last
        ? Buffer.from(last.id).toString("base64url")
        : null;
    return NextResponse.json(
      { sounds, nextCursor },
      { headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}

export async function POST(request: Request) {
  try {
    const player = await contributionPlayer(request);
    const body = await contributionBody(request);
    const status = contributionStatus(body.status);
    const fields = soundFields(body);
    const soundKey = adminSoundUploadKey(body.soundKey, `player_${player.id}`);
    await limitContribution(player.id, "sound-publish", 10);
    await verifySoundUpload(soundKey);
    const id = soundKey.split("/").at(-1)!.split(".")[0];
    const ref = adminDb!.collection("soundboardSounds").doc(id);
    await adminDb!.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        if (
          existing.data()?.uploaderId !== player.id ||
          existing.data()?.soundKey !== soundKey
        )
          throw new ContributionError(409);
        return;
      }
      transaction.create(ref, {
        ...fields,
        status,
        soundKey,
        color: 0,
        playCount: 0,
        createdBy: `player:${player.id}`,
        uploaderId: player.id,
        source: "revamp",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return NextResponse.json(
      { id },
      { status: 201, headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}
