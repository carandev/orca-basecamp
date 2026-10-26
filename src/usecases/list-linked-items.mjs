import { parseLink } from '../domain/link.mjs';

/**
 * Returns the set of Basecamp items that already have a worktree linked to them.
 * Reads every `link:*` key from storage and collects `{type, id}` from valid link records.
 * Never throws.
 */
export async function listLinkedItems({ storage }) {
  let keys;
  try {
    keys = await storage.keys();
  } catch {
    return [];
  }
  const linked = [];
  for (const key of keys) {
    if (!key.startsWith('link:')) continue;
    let record;
    try {
      record = parseLink(await storage.get(key));
    } catch {
      continue;
    }
    if (record) linked.push({ type: record.type, id: record.id });
  }
  return linked;
}
