const TYPES = ['todo', 'card'];
const isId = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0) || (typeof v === 'string' && /^\d+$/.test(v));

export const linkKey = (worktreeId) => `link:${worktreeId}`;

/** Stored link record, version 1 (a v2 record is a v1 plus an optional `sync` baseline). */
export function buildLink({ type, id, projectId, appUrl, title, now }) {
  return { v: 1, type, id, projectId, appUrl, title, createdAt: now };
}

const validSync = (s) =>
  s !== null &&
  typeof s === 'object' &&
  typeof s.orca === 'string' &&
  typeof s.bc === 'string' &&
  typeof s.at === 'number' &&
  (s.lastOpenOrca === undefined || typeof s.lastOpenOrca === 'string');

/**
 * Returns the record when it is a valid v1 or v2 link, otherwise null.
 * A malformed `sync` is dropped (the next tick takes a fresh snapshot instead of writing).
 */
export function parseLink(value) {
  if (value === null || typeof value !== 'object') return null;
  if ((value.v !== 1 && value.v !== 2) || !TYPES.includes(value.type) || !isId(value.id) || !isId(value.projectId)) return null;
  if (value.v === 2 && 'sync' in value && !validSync(value.sync)) {
    const { sync, ...rest } = value;
    return rest;
  }
  return value;
}

/** Copy of `link` as a v2 record carrying the baseline `sync:{orca, bc, at, lastOpenOrca?}`. */
export function withSync(link, sync) {
  return { ...link, v: 2, sync };
}
