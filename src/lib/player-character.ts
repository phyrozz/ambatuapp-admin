import { ContributionError } from "./community-content";
import { isPlayerCharacterImageKey } from "./s3-images";

export function playerCharacterFields(
  body: Record<string, unknown>,
  playerId: string,
  existingImageKey?: string | null,
) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const bio = typeof body.bio === "string" ? body.bio.trim() : "";
  if (
    !name ||
    name.length > 120 ||
    !title ||
    title.length > 120 ||
    bio.length > 20000
  )
    throw new ContributionError(400);
  if (body.status !== "Draft" && body.status !== "Published")
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
  const imageKey = body.imageKey || null;
  if (imageKey !== null && imageKey !== existingImageKey && !isPlayerCharacterImageKey(imageKey, playerId))
    throw new ContributionError(400);
  return {
    name,
    title,
    bio,
    tags,
    status: body.status,
    imageKey: imageKey as string | null,
  };
}
