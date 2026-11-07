export type DreamAudience = 'public' | 'friends' | 'only_me';
export type DreamAccessRecord = {
  authorId: string;
  audience: DreamAudience;
  publication: 'draft' | 'processing' | 'published' | 'failed';
  moderation: 'visible' | 'removed';
  authorDeleting: boolean;
};
export type DreamRelationship = { blocked: boolean; acceptedByViewer: boolean; acceptedByAuthor: boolean };

/** Call with a verified viewer and freshly read relationship; never client-provided flags. */
export function canReadDream(viewerId: string | null, dream: DreamAccessRecord, relationship: DreamRelationship) {
  if (dream.authorDeleting || relationship.blocked) return false;
  if (viewerId === dream.authorId) return true;
  if (dream.publication !== 'published' || dream.moderation !== 'visible') return false;
  if (dream.audience === 'public') return true;
  return Boolean(viewerId && dream.audience === 'friends' && relationship.acceptedByViewer && relationship.acceptedByAuthor);
}

export function canInteractWithDream(viewerId: string | null, dream: DreamAccessRecord, relationship: DreamRelationship) {
  return Boolean(viewerId && dream.publication === 'published' && dream.moderation === 'visible' && canReadDream(viewerId, dream, relationship));
}
