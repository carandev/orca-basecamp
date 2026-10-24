import { linkKey } from '../domain/link.mjs';
import { describeFailure, safeNotify } from './failure.mjs';
import { resolveLinked } from './resolve-linked.mjs';

const TITLE = 'Basecamp: Complete';
const NO_LINK = 'No linked item for the active worktree.';

/**
 * Complete command: completes the item linked to the active worktree. One attempt, never retried.
 * The link is removed only when the item was completed; any other outcome keeps it.
 * Never throws. Resolves to `{status: 'no_link'|'completed'|'already'|'inaccessible'|'failed'}`.
 */
export function createCompleteLinked({ orca, storage, source, notify }) {
  return async function completeLinked() {
    let linked;
    try {
      linked = await resolveLinked({ orca, storage });
    } catch (error) {
      await safeNotify(notify, TITLE, describeFailure(error));
      return { status: 'failed' };
    }
    if (!linked) {
      await safeNotify(notify, TITLE, NO_LINK);
      return { status: 'no_link' };
    }
    const { worktreeId, link } = linked;
    let outcome;
    try {
      outcome = await source.complete({ type: link.type, id: link.id, projectId: link.projectId });
    } catch (error) {
      await safeNotify(notify, TITLE, `${describeFailure(error)} (${link.title}: ${link.appUrl})`);
      return { status: 'failed' };
    }
    if (outcome.status === 'completed') {
      try {
        await storage.delete(linkKey(worktreeId));
      } catch {
        // the item is done; a stale link is harmless
      }
      await safeNotify(notify, TITLE, `Completed: ${link.title}`);
    } else if (outcome.status === 'already') {
      await safeNotify(notify, TITLE, `Already completed: ${link.title}`);
    } else {
      await safeNotify(notify, TITLE, `Not accessible, nothing was changed: ${link.title} (${link.appUrl})`);
    }
    return { status: outcome.status };
  };
}
