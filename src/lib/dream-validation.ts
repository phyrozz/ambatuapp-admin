export class DreamError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}
export const DREAM_TEXT_LIMIT = 2000;
export function dreamVoteBody(value: unknown): -1 | 0 | 1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DreamError("INVALID_VOTE", 422);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || ![-1, 0, 1].includes(body.value as number))
    throw new DreamError("INVALID_VOTE", 422);
  return body.value as -1 | 0 | 1;
}
export const validDreamId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function validText(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) return false;
  const points = Array.from(value);
  return (
    points.length <= DREAM_TEXT_LIMIT &&
    !points.some((point) => {
      const code = point.codePointAt(0)!;
      return code === 0 || (code >= 0xd800 && code <= 0xdfff);
    })
  );
}
type Body = {
  text?: string;
  audience?: "public" | "friends" | "only_me";
  publish?: boolean;
  revision?: number;
  attachmentIds?: string[];
};
export function dreamBody(value: unknown, editing = false): Body {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DreamError("INVALID_DREAM", 422);
  const body = value as Record<string, unknown>;
  const allowed = [
    "text",
    "audience",
    "publish",
    "attachmentIds",
    ...(editing ? ["revision"] : []),
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new DreamError("INVALID_DREAM", 422);
  if (
    body.attachmentIds !== undefined &&
    (!Array.isArray(body.attachmentIds) ||
      body.attachmentIds.length > 25 ||
      !body.attachmentIds.every(validDreamId) ||
      new Set(body.attachmentIds).size !== body.attachmentIds.length)
  )
    throw new DreamError("INVALID_DREAM", 422);
  const hasMedia =
    Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
  if (
    (!editing || body.text !== undefined) &&
    !validText(
      body.text ?? (!editing && hasMedia ? "" : undefined),
      editing || hasMedia,
    )
  )
    throw new DreamError("INVALID_DREAM", 422);
  if (
    body.audience !== undefined &&
    !["public", "friends", "only_me"].includes(body.audience as string)
  )
    throw new DreamError("INVALID_DREAM", 422);
  if (body.publish !== undefined && typeof body.publish !== "boolean")
    throw new DreamError("INVALID_DREAM", 422);
  if (
    editing &&
    (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1)
  )
    throw new DreamError("INVALID_DREAM", 422);
  if (
    editing &&
    !["text", "audience", "publish", "attachmentIds"].some(
      (key) => body[key] !== undefined,
    )
  )
    throw new DreamError("INVALID_DREAM", 422);
  return {
    ...(body.text !== undefined || (!editing && hasMedia)
      ? { text: (body.text ?? "") as string }
      : {}),
    ...(body.audience !== undefined
      ? { audience: body.audience as Body["audience"] }
      : {}),
    ...(body.publish !== undefined ? { publish: body.publish as boolean } : {}),
    ...(body.attachmentIds !== undefined
      ? { attachmentIds: body.attachmentIds as string[] }
      : {}),
    ...(editing ? { revision: body.revision as number } : {}),
  };
}
export function dreamIdempotencyKey(value: string | null) {
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/.test(value))
    throw new DreamError("INVALID_IDEMPOTENCY_KEY", 422);
  return value;
}
export function dreamCursor(
  raw: string | null,
  owner: string,
): { time: string; id: string } | null {
  if (!raw) return null;
  try {
    if (raw.length > 1024) throw new Error();
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      parsed.v !== 1 ||
      parsed.owner !== owner ||
      !validDreamId(parsed.id) ||
      typeof parsed.time !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.time) ||
      !Number.isFinite(Date.parse(parsed.time))
    )
      throw new Error();
    if (
      new Date(parsed.time).toISOString().slice(0, 19) !==
      parsed.time.slice(0, 19)
    )
      throw new Error();
    return { time: parsed.time, id: parsed.id };
  } catch {
    throw new DreamError("INVALID_CURSOR", 400);
  }
}
