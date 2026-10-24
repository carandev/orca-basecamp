import { linkKey, parseLink } from '../domain/link.mjs';
import { describeFailure, safeNotify } from './failure.mjs';

const TITLE = 'Basecamp: worktree removed';

/**
 * `worktree.removed` handler. Linked worktree: one completion attempt (the adapter caps it at 10 s), then the link
 * is deleted on every outcome, because the worktree is gone and no command can resolve that link again.
 * A failure notice carries the title and appUrl so the user can finish by hand. Unlinked worktree: no-op.
 * Never throws and never retries.
 */
export function createOnRemoved({ storage, source, notify }) {
  return async function onRemoved(event) {
    const worktreeId = event?.worktreeId;
    if (!worktreeId) return;
    let link;
    try {
      link = parseLink(await storage.get(linkKey(worktreeId)));
    } catch {
      return;
    }
    if (!link) return;
    let message;
    try {
      const { status } = await source.complete({ type: link.type, id: link.id, projectId: link.projectId });
      message =
        status === 'completed'
          ? `Completed: ${link.title}`
          : status === 'already'
            ? `Already completed: ${link.title}`
            : `Not accessible, nothing was changed: ${link.title} (${link.appUrl})`;
    } catch (error) {
      message = `Could not complete "${link.title}" (${link.appUrl}): ${describeFailure(error)}`;
    }
    try {
      await storage.delete(linkKey(worktreeId));
    } catch {
      // an orphan key is the lesser harm; the handler must not throw
    }
    await safeNotify(notify, TITLE, message);
  };
}
