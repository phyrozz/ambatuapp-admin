import { randomUUID } from "node:crypto";

// Shared by the API and streaming gateway. $2 is always the verified viewer.
export const eligibleDream = `NOT EXISTS (SELECT 1 FROM app.player_deletions WHERE player_id=d.author_id OR player_id=$2)
 AND NOT EXISTS (SELECT 1 FROM app.player_blocks WHERE (blocker_id=$2 AND blocked_id=d.author_id) OR (blocker_id=d.author_id AND blocked_id=$2))
 AND (d.author_id=$2 OR (d.publication='published' AND d.moderation='visible' AND (d.audience='public' OR
 (d.audience='friends' AND EXISTS (SELECT 1 FROM app.friendships WHERE player_id=$2 AND other_player_id=d.author_id AND state='accepted')
 AND EXISTS (SELECT 1 FROM app.friendships WHERE player_id=d.author_id AND other_player_id=$2 AND state='accepted')))))`;

export const attachmentDto = (row) => ({
  id: row.id,
  kind: row.kind,
  state: row.state,
  bytes: Number(row.output_bytes ?? row.declared_bytes),
  width: row.width,
  height: row.height,
  duration: row.duration == null ? null : Number(row.duration),
  error: row.error_code,
});

export async function cleanupJob(db, owner, rows, mode = "all", parentId) {
  const id = randomUUID();
  const attachments = rows.map((row) => row.id),
    dreams = [
      ...new Set([
        ...rows.map((row) => row.dream_id).filter(Boolean),
        ...(parentId ? [parentId] : []),
      ]),
    ];
  const dependencies = (
    await db.query(
      `SELECT id FROM app.dream_media_jobs WHERE owner_id=$1 AND state='pending'
    AND (attachment_ids && $2::uuid[] OR dream_ids && $3::uuid[])`,
      [owner, attachments, dreams],
    )
  ).rows.map((row) => row.id);
  const prefixes = [
    ...new Set(
      rows.flatMap((row) => [
        ...(mode !== "output"
          ? [row.input_key.slice(0, row.input_key.lastIndexOf("/") + 1)]
          : []),
        ...(mode !== "input" && row.output_prefix ? [row.output_prefix] : []),
      ]),
    ),
  ];
  if (!prefixes.length && !dependencies.length) return null;
  await db.query(
    `INSERT INTO app.dream_media_jobs(id,owner_id,attachment_ids,prefixes,not_before,dream_ids,depends_on,reserved_bytes)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      owner,
      attachments,
      prefixes,
      new Date(
        Math.max(
          Date.now(),
          ...rows.map((r) => new Date(r.upload_expires_at).getTime()),
          ...rows
            .filter((r) => r.lease_until)
            .map((r) => new Date(r.lease_until).getTime() + 120_000),
        ),
      ),
      dreams,
      dependencies,
      rows.reduce(
        (total, row) =>
          total +
          (mode !== "output"
            ? Number(row.declared_bytes ?? 200 * 1024 ** 2)
            : 0) +
          (mode !== "input" && row.output_prefix
            ? Number(
                row.output_bytes ??
                  (row.kind === "image" ? 10 : 200) * 1024 ** 2,
              ) +
              1024 ** 2
            : 0),
        0,
      ),
    ],
  );
  return id;
}

export async function removeUnused(db, dream) {
  const keep = [
    ...new Set([
      ...dream.attachment_ids,
      ...(dream.pending_edit?.attachmentIds ?? []),
    ]),
  ];
  const removed = (
    await db.query(
      "SELECT * FROM app.dream_attachments WHERE dream_id=$1 AND NOT(id=ANY($2::uuid[])) FOR UPDATE",
      [dream.id, keep],
    )
  ).rows;
  if (!removed.length) return;
  await cleanupJob(db, dream.author_id, removed);
  await db.query("DELETE FROM app.dream_attachments WHERE id=ANY($1::uuid[])", [
    removed.map((r) => r.id),
  ]);
}

// Caller holds the author advisory lock. It fences publication against edits/deletion.
export async function reconcileDream(db, id) {
  let dream = (
    await db.query("SELECT * FROM app.dreams WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!dream?.pending_edit) return dream;
  const pending = dream.pending_edit;
  const rows = (
    await db.query(
      "SELECT state FROM app.dream_attachments WHERE dream_id=$1 AND id=ANY($2::uuid[])",
      [id, pending.attachmentIds],
    )
  ).rows;
  if (
    rows.length === pending.attachmentIds.length &&
    rows.every((row) => row.state === "ready")
  ) {
    dream = (
      await db.query(
        `UPDATE app.dreams SET body=$2,audience=$3,attachment_ids=$4,pending_edit=NULL,
      publication=$5,published_at=CASE WHEN $5='published' THEN coalesce(published_at,now()) ELSE published_at END,
      revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
        [
          id,
          pending.text,
          pending.audience,
          pending.attachmentIds,
          pending.publish ? "published" : "draft",
        ],
      )
    ).rows[0];
    await removeUnused(db, dream);
  } else if (dream.publication !== "published") {
    await db.query("UPDATE app.dreams SET publication=$2 WHERE id=$1", [
      id,
      rows.some((r) => r.state === "failed") ? "failed" : "processing",
    ]);
  }
  return dream;
}

export async function stageContent(db, dream, body) {
  const current = dream.pending_edit ?? {
    text: dream.body,
    audience: dream.audience,
    attachmentIds: dream.attachment_ids,
  };
  const text = body.text ?? current.text,
    audience = body.audience ?? current.audience;
  const ids = body.attachmentIds ?? current.attachmentIds;
  const publish =
    body.publish ??
    dream.pending_edit?.publish ??
    dream.publication !== "draft";
  if (
    (!text.trim() && !ids.length) ||
    ids.length > 25 ||
    new Set(ids).size !== ids.length
  )
    return "INVALID_DREAM";
  const rows = (
    await db.query(
      "SELECT * FROM app.dream_attachments WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",
      [ids],
    )
  ).rows;
  if (
    rows.length !== ids.length ||
    rows.some(
      (r) =>
        r.owner_id !== dream.author_id ||
        (r.dream_id && r.dream_id !== dream.id) ||
        r.state === "cancelled",
    )
  )
    return "INVALID_ATTACHMENTS";
  await db.query(
    "UPDATE app.dream_attachments SET dream_id=$2 WHERE id=ANY($1::uuid[])",
    [ids, dream.id],
  );
  const ready = rows.every((row) => row.state === "ready");
  const pending =
    publish && !ready ? { text, audience, attachmentIds: ids, publish } : null;
  const privacy = { public: 0, friends: 1, only_me: 2 };
  const retainPublished = Boolean(pending && dream.publication === "published");
  // Tightening privacy takes effect immediately even while replacements process.
  const effectiveAudience =
    retainPublished && privacy[audience] < privacy[dream.audience]
      ? dream.audience
      : audience;
  const updated = (
    await db.query(
      `UPDATE app.dreams SET body=$2,audience=$3,attachment_ids=$4,pending_edit=$5,publication=$6,
    published_at=CASE WHEN $6='published' THEN coalesce(published_at,now()) ELSE published_at END,updated_at=now()
    WHERE id=$1 RETURNING *`,
      [
        dream.id,
        retainPublished ? dream.body : text,
        effectiveAudience,
        retainPublished ? dream.attachment_ids : ids,
        pending,
        retainPublished
          ? "published"
          : pending
            ? rows.some((r) => r.state === "failed")
              ? "failed"
              : "processing"
            : publish
              ? "published"
              : "draft",
      ],
    )
  ).rows[0];
  await removeUnused(db, updated);
  return null;
}
