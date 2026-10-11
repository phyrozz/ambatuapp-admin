import { ContributionError } from "./community-content";
import { LORE_TEXT_LIMIT, validateLoreTranslations } from "./lore";
import { isPlayerLoreImageKey } from "./s3-images";

export function loreFields(body: Record<string, unknown>, playerId: string) {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
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
    body.imageKeys.some((key) => !isPlayerLoreImageKey(key, playerId))
  )
    throw new ContributionError(400);
  const imageKeys = [...new Set(body.imageKeys as string[])];
  if (imageKeys.length !== body.imageKeys.length)
    throw new ContributionError(400);
  return { title, text, tags, translations, imageKeys };
}
