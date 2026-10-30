import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { isDevLoreWriter } from "../../../../../lib/dev-content-db";
import { createCreatorLore, listCreatorLores } from "../../../../../lib/dev-lores";
import { NextResponse } from "next/server";
import { adminDb } from "../../../../../lib/firebase-admin";
import { signedCharacterImageUrl } from "../../../../../lib/s3-images";
import {
  ContributionError,
  contributionBody,
  contributionError,
  contributionHeaders,
  contributionPlayer,
  contributionStatus,
  limitContribution,
} from "../../../../../lib/community-content";
import {
  LORE_TEXT_LIMIT,
  validateLoreTranslations,
} from "../../../../../lib/lore";
import {
  isPlayerLoreImageKey,
  verifyPlayerLoreImage,
} from "../../../../../lib/s3-images";

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
    if (isDevLoreWriter()) return NextResponse.json(await listCreatorLores(player.id, url), { headers: contributionHeaders });
    const requestedLimit = Number(url.searchParams.get("limit")) || 20;
    const limit = Math.min(50, Math.max(1, Math.floor(requestedLimit)));
    const collection = adminDb!.collection("lores");
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
    const lores = await Promise.all(
      page.map(async (doc) => {
        const data = doc.data();
        const imageKeys = Array.isArray(data.imageKeys)
          ? data.imageKeys.filter((key): key is string =>
              isPlayerLoreImageKey(key, player.id),
            )
          : [];
        const imageUrls = await Promise.all(
          imageKeys.map(
            async (key) => (await signedCharacterImageUrl(key)) ?? "",
          ),
        );
        return {
          id: doc.id,
          status: data.status === 'Draft' ? 'Draft' : 'Published',
          title: typeof data.title === "string" ? data.title : "",
          text: typeof data.text === "string" ? data.text : "",
          viewCount: typeof data.viewCount === 'number' && Number.isSafeInteger(data.viewCount) && data.viewCount > 0 ? data.viewCount : 0,
          upvotes: typeof data.upvotes === 'number' && Number.isSafeInteger(data.upvotes) && data.upvotes > 0 ? data.upvotes : 0,
          downvotes: typeof data.downvotes === 'number' && Number.isSafeInteger(data.downvotes) && data.downvotes > 0 ? data.downvotes : 0,
          commentCount: typeof data.commentCount === 'number' && Number.isSafeInteger(data.commentCount) && data.commentCount > 0 ? data.commentCount : 0,
          tags: Array.isArray(data.tags)
            ? data.tags.filter((tag): tag is string => typeof tag === "string")
            : [],
          translations: Array.isArray(data.translations)
            ? data.translations
            : [],
          imageKeys,
          imageUrls,
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
      { lores, nextCursor },
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
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (
      typeof body.submissionId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        body.submissionId,
      )
    )
      throw new ContributionError(400);
    if (!title || title.length > 120 || !text || text.length > LORE_TEXT_LIMIT)
      throw new ContributionError(400);
    if (
      !Array.isArray(body.tags) ||
      body.tags.length > 10 ||
      body.tags.some(
        (tag) => typeof tag !== "string" || !tag.trim() || tag.length > 40,
      )
    )
      throw new ContributionError(400);
    const tags = [...new Set((body.tags as string[]).map((tag) => tag.trim()))];
    const translations = body.translations ?? [];
    if (!Array.isArray(translations) || translations.length > 10)
      throw new ContributionError(400);
    validateLoreTranslations(translations);
    if (
      translations.some(
        (entry) =>
          (typeof entry.label === "string" && entry.label.length > 48) ||
          (typeof entry.title === "string" && entry.title.length > 120),
      )
    )
      throw new ContributionError(400);
    if (
      !Array.isArray(body.imageKeys) ||
      body.imageKeys.length > 5 ||
      body.imageKeys.some((key) => !isPlayerLoreImageKey(key, player.id))
    )
      throw new ContributionError(400);
    const imageKeys = [...new Set(body.imageKeys as string[])];
    if (imageKeys.length !== body.imageKeys.length)
      throw new ContributionError(400);
    await limitContribution(player.id, "lore-publish", 10);
    await Promise.all(imageKeys.map(verifyPlayerLoreImage));
    if (isDevLoreWriter()) {
      await createCreatorLore(player.id, body.submissionId, { title, text, tags, translations, imageKeys }, status);
      return NextResponse.json({ id: body.submissionId }, { status: 201, headers: contributionHeaders });
    }
    const ref = adminDb!.collection("lores").doc(body.submissionId);
    await adminDb!.runTransaction(async (transaction) => {
      const existing = await transaction.get(ref);
      if (existing.exists) {
        if (existing.data()?.uploaderId !== player.id)
          throw new ContributionError(409);
        return;
      }
      transaction.create(ref, {
        title,
        text,
        tags,
        translations,
        imageKeys,
        status,
        upvotes: 0,
        downvotes: 0,
        commentCount: 0,
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
