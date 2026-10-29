// Add settings categories independently so future modules need not share a record.
export const CHAT_LIMIT_DEFAULTS = {
  send: { limit: 30, seconds: 60 },
  mediaUpload: { limit: 10, seconds: 600 },
  history: { limit: 60, seconds: 60 },
  createConversation: { limit: 20, seconds: 600 },
  addGroupMember: { limit: 30, seconds: 600 },
  createGroupInvite: { limit: 30, seconds: 600 },
  acceptGroupInvite: { limit: 30, seconds: 600 },
  registerPush: { limit: 20, seconds: 600 },
  default: { limit: 120, seconds: 60 },
} as const;
export type LimitKey = keyof typeof CHAT_LIMIT_DEFAULTS;
export type ChatLimits = Record<LimitKey, { limit: number; seconds: number }>;
