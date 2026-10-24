import { linkKey, parseLink } from '../domain/link.mjs';

/**
 * Link of the active worktree: `{worktreeId, link}`, or null when no worktree is focused or it has no (valid) link.
 * Orca is asked only to resolve the active worktree; storage is read only after that. Throws when resolution fails.
 */
export async function resolveLinked({ orca, storage }) {
  const active = await orca.resolveActiveWorktree();
  if (!active) return null;
  const link = parseLink(await storage.get(linkKey(active.worktreeId)));
  return link ? { worktreeId: active.worktreeId, link } : null;
}
