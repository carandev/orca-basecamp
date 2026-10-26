import { linkKey, parseLink, withSync } from '../domain/link.mjs';
import { describeFailure, safeNotify } from './failure.mjs';
import { resolveLinked } from './resolve-linked.mjs';

const TITLE = 'Basecamp: Complete';
const NO_LINK = 'No linked item for the active worktree.';

/**
 * Complete command: completes the item linked to the active worktree. One attempt, never retried.
 * The link is always kept. On `completed` or `already` the baseline becomes completed/completed (also with sync off),
 * after setting the Orca status to completed when sync is on; if that set fails no baseline is written, so the
 * next tick propagates the change. Any other outcome writes nothing.
 * If removeOnComplete is enabled, the worktree is also removed.
 * Never throws. Resolves to `{status: 'no_link'|'completed'|'already'|'inaccessible'|'failed'}`.
 */
export function createCompleteLinked({ orca, storage, source, notify, loadSyncConfig, clock }) {
  /** Returns a problem description when the Orca status, baseline, or worktree removal could not be completed, else null. */
  async function recordCompletion(worktreeId, link) {
    let config;
    try {
      config = await loadSyncConfig();
      if (config?.enabled) await orca.setStatus(worktreeId, 'completed');
      const current = parseLink(await storage.get(linkKey(worktreeId)));
      if (!current) return null;
      const { lastOpenOrca } = link.sync ?? {};
      const sync = { orca: 'completed', bc: 'completed', at: clock.now(), ...(lastOpenOrca === undefined ? {} : { lastOpenOrca }) };
      await storage.set(linkKey(worktreeId), withSync(current, sync));
    } catch (error) {
      return { msg: `Orca status not updated: ${describeFailure(error)}` };
    }
    if (config?.removeOnComplete && typeof orca.removeWorktree === 'function') {
      try {
        await orca.removeWorktree(worktreeId);
      } catch (error) {
        return { msg: `worktree not removed: ${describeFailure(error)}` };
      }
    }
    return null;
  }

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
    if (outcome.status === 'completed' || outcome.status === 'already') {
      const problem = await recordCompletion(worktreeId, link);
      const text = outcome.status === 'completed' ? `Completed: ${link.title}` : `Already completed: ${link.title}`;
      await safeNotify(notify, TITLE, problem ? `${text} (${problem.msg})` : text);
    } else {
      await safeNotify(notify, TITLE, `Not accessible, nothing was changed: ${link.title} (${link.appUrl})`);
    }
    return { status: outcome.status };
  };
}
