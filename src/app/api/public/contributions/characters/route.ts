import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { isDevCharacterWriter } from "../../../../../lib/dev-content-db";
import { createCreatorCharacter, listCreatorCharacters } from "../../../../../lib/dev-characters";
import { NextResponse } from "next/server";
import { signedCharacterImageUrl } from "../../../../../lib/s3-images";
import {
  requireContributionFirestore,
  ContributionError,
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  limitContribution,
} from "../../../../../lib/community-content";
import { playerCharacterFields } from "../../../../../lib/player-character";
import { verifyPlayerCharacterImage } from "../../../../../lib/s3-images";

export const runtime = "nodejs";
export function OPTIONS() {
  return new NextResponse(null, { headers: contributionHeaders });
}

function cursorId(value: string | null) {
  if (!value) return null;
  try {
    const id = Buffer.from(value, "base64url").toString("utf8");
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        id,
      )
    )
      throw new Error();
    return id;
  } catch {
    throw new ContributionError(400);
  }
}

export async function GET(request: Request) {
  try {
    const player = await contributionPlayer(request);
    const url = new URL(request.url);
    if (isDevCharacterWriter()) return NextResponse.json(await listCreatorCharacters(player.id, url), { headers: contributionHeaders });
    const requestedLimit = Number(url.searchParams.get("limit")) || 20;
    const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
    const collection = requireContributionFirestore().collection("characters");
    const afterId = cursorId(url.searchParams.get("cursor"));
    let query = collection
      .where("uploaderId", "==", player.id)
      .where("source", "==", "revamp")
      .orderBy("createdAt", "desc")
      .orderBy(FieldPath.documentId(), "desc")
      .limit(limit + 1);
    if (afterId) {
      const cursor = await collection.doc(afterId).get();
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
    const characters = await Promise.all(
      page.map(async (doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name ?? "",
          title: data.title ?? "",
          bio: data.bio ?? "",
          tags: data.tags ?? [],
          status: data.status,
          viewCount: typeof data.viewCount === 'number' && Number.isSafeInteger(data.viewCount) && data.viewCount > 0 ? data.viewCount : 0,
          imageKey: data.imageKey ?? null,
          imageUrl: (await signedCharacterImageUrl(data.imageKey)) ?? null,
          createdAt:
            (data.createdAt as { toDate?: () => Date } | undefined)
              ?.toDate?.()
              .toISOString() ?? null,
        };
      }),
    );
    const last = page.at(-1);
    const nextCursor =
      snapshot.docs.length > limit && last
        ? Buffer.from(last.id).toString("base64url")
        : null;
    return NextResponse.json(
      { characters, nextCursor },
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
    const fields = playerCharacterFields(body, player.id);
    if (
      typeof body.submissionId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        body.submissionId,
      )
    )
      throw new ContributionError(400);
    await limitContribution(player.id, "character-create", 10);
    if (fields.imageKey) await verifyPlayerCharacterImage(fields.imageKey);
    if (isDevCharacterWriter()) {
      await createCreatorCharacter(player.id, body.submissionId, fields);
      return NextResponse.json({ id: body.submissionId }, { status: 201, headers: contributionHeaders });
    }
    const ref = requireContributionFirestore().collection("characters").doc(body.submissionId);
    await requireContributionFirestore().runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        if (
          existing.data()?.uploaderId !== player.id ||
          existing.data()?.source !== "revamp"
        )
          throw new ContributionError(409);
        return;
      }
      transaction.create(ref, {
        ...fields,
        createdBy: `player:${player.id}`,
        uploaderId: player.id,
        source: "revamp",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updated: "Just now",
      });
    });
    return NextResponse.json(
      { id: ref.id },
      { status: 201, headers: contributionHeaders },
    );
  } catch (error) {
    return contributionError(error);
  }
}
