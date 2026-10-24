const TYPES = ['todo', 'card'];
const isId = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v));

export const linkKey = (worktreeId) => `link:${worktreeId}`;

/** Stored link record, version 1. */
export function buildLink({ type, id, projectId, appUrl, title, now }) {
  return { v: 1, type, id, projectId, appUrl, title, createdAt: now };
}

/** Returns the record when it is a valid v1 link, otherwise null. */
export function parseLink(value) {
  if (value === null || typeof value !== 'object') return null;
  if (value.v !== 1 || !TYPES.includes(value.type) || !isId(value.id) || !isId(value.projectId)) return null;
  return value;
}
