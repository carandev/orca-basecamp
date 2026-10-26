import { buildLink, linkKey, parseLink } from '../domain/link.mjs';
import { describeFailure, safeNotify } from './failure.mjs';

const TITLE = 'Basecamp: Link item to this worktree';

/**
 * Links an EXISTING worktree to a Basecamp item. The item is refetched from the source (the request carries only
 * ids), so client text never reaches storage. The record is v2 with no `sync` baseline: the first sync tick only
 * snapshots both sides. Orca's status and comment are not touched and no agent is launched.
 * An existing link on the worktree is replaced, and the replaced item is announced.
 * Resolves, never throws: `{status: 'linked', title}` | `{status: 'failed', error, hint?}`.
 */
export function createLinkExisting({ source, storage, notify, clock }) {
  return async function linkExisting({ worktreeId, displayName, type, id, projectId }) {
    let item;
    try {
      item = await source.get({ type, id, projectId });
    } catch (error) {
      await safeNotify(notify, `${TITLE} failed`, describeFailure(error));
      return { status: 'failed', error: error.message, hint: error.hint };
    }
    try {
      const previous = parseLink(await storage.get(linkKey(worktreeId)));
      const link = {
        ...buildLink({ type: item.type, id: item.id, projectId: item.projectId, appUrl: item.appUrl, title: item.title, now: clock.now() }),
        v: 2
      };
      await storage.set(linkKey(worktreeId), link);
      if (previous) await safeNotify(notify, TITLE, `Replaced the link to "${previous.title}" on ${displayName}`);
      await safeNotify(notify, TITLE, `Linked ${item.title} to ${displayName}`);
      return { status: 'linked', title: item.title };
    } catch (error) {
      await safeNotify(notify, `${TITLE} failed`, describeFailure(error));
      return { status: 'failed', error: error?.message ?? String(error) };
    }
  };
}
