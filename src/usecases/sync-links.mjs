import { linkKey, parseLink, withSync } from '../domain/link.mjs';
import { normalizeSyncConfig } from '../domain/mapping.mjs';
import { reconcile } from '../domain/sync.mjs';
import { describeFailure, safeNotify } from './failure.mjs';
import { SYNC_CONFIG_KEY } from './sync-config.mjs';

const TITLE = 'Basecamp: sync';
const LINK_PREFIX = 'link:';
const FATAL_CODE = /^cli_not_found$|auth/i;

const isFatal = (error) => FATAL_CODE.test(String(error?.code ?? ''));
const sameBaseline = (a, b) => a?.orca === b.orca && a?.bc === b.bc && a?.lastOpenOrca === b.lastOpenOrca;

/**
 * One sync pass over the linked items. `tick()` never throws and resolves to
 * `{status: 'disabled'|'ok'|'orca_failed'|'failed', attempted, failed, synced, conflicts, fatal?}`.
 * Notifications are conflicts and failures only; a failure is repeated only after the item succeeded again.
 */
export function createSyncLinks({ storage, source, orca, notify, clock, concurrency = 3 }) {
  const failing = new Map(); // worktreeId -> last notified failure code
  let truncatedNotified = false;
  let noStatusNotified = false;

  const notifyFailure = async (worktreeId, error, label) => {
    const code = String(error?.code ?? 'error');
    if (failing.get(worktreeId) === code) return;
    failing.set(worktreeId, code);
    await safeNotify(notify, TITLE, `Could not sync ${label}: ${describeFailure(error)}`);
  };

  async function readLinks(keys) {
    const links = [];
    for (const key of keys.filter((k) => k.startsWith(LINK_PREFIX))) {
      const link = parseLink(await storage.get(key));
      if (link && link.type === 'todo') links.push({ worktreeId: key.slice(LINK_PREFIX.length), link });
    }
    return links;
  }

  /** Writes the baseline unless the link was removed meanwhile or the baseline did not change. */
  async function persistBaseline(worktreeId, baseline) {
    const current = parseLink(await storage.get(linkKey(worktreeId)));
    if (!current || sameBaseline(current.sync, baseline)) return;
    await storage.set(linkKey(worktreeId), withSync(current, { ...baseline, at: clock.now() }));
  }

  async function write(link, plan, worktreeId) {
    const ref = { type: link.type, id: link.id, projectId: link.projectId };
    if (plan.writeBc !== undefined) {
      const outcome =
        plan.writeBc === 'completed' ? await source.complete(ref) : await source.reopen({ id: link.id, projectId: link.projectId });
      if (outcome.status === 'inaccessible') {
        throw Object.assign(new Error(`"${link.title}" is not accessible in Basecamp`), { code: 'inaccessible' });
      }
    }
    if (plan.writeOrca !== undefined) await orca.setStatus(worktreeId, plan.writeOrca);
  }

  async function syncItem({ worktreeId }, { statuses, config }, summary) {
    const link = parseLink(await storage.get(linkKey(worktreeId)));
    if (!link) return;
    summary.attempted += 1;
    try {
      const bc = await source.state({ type: link.type, id: link.id, projectId: link.projectId });
      const plan = reconcile({
        kind: link.type,
        baseline: link.sync,
        orca: statuses.get(worktreeId),
        bc,
        statusToColumn: config.statusToColumn[link.projectId] ?? {},
        rule: config.conflictRule
      });
      await write(link, plan, worktreeId);
      await persistBaseline(worktreeId, plan.baseline);
      failing.delete(worktreeId);
      if (plan.writeBc !== undefined || plan.writeOrca !== undefined) summary.synced += 1;
      if (plan.conflict) summary.conflictItems.push({ title: link.title, ...plan.conflict });
    } catch (error) {
      summary.failed += 1;
      if (isFatal(error)) {
        summary.fatal ??= { code: String(error.code), message: describeFailure(error) };
        return;
      }
      await notifyFailure(worktreeId, error, `"${link.title}"`);
    }
  }

  async function runPool(items, context, summary) {
    const queue = [...items];
    const worker = async () => {
      while (queue.length > 0 && !summary.fatal) await syncItem(queue.shift(), context, summary);
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  async function run() {
    const summary = { status: 'ok', attempted: 0, failed: 0, synced: 0, conflicts: 0, conflictItems: [] };
    const keys = await storage.keys(); // first host call of every tick: keeps the worker alive
    const config = normalizeSyncConfig(await storage.get(SYNC_CONFIG_KEY));
    if (!config.enabled) return { ...summary, status: 'disabled' };

    const links = await readLinks(keys);
    if (links.length === 0) return summary;

    let listed;
    try {
      listed = await orca.listWorktreeStatuses({ limit: 1000 });
    } catch (error) {
      await notifyFailure('orca', error, 'the Orca worktree list');
      return { ...summary, status: 'orca_failed' };
    }
    failing.delete('orca');

    if (listed.truncated && !truncatedNotified) {
      await safeNotify(notify, TITLE, 'The Orca worktree list was truncated; only the returned worktrees are synced.');
    }
    truncatedNotified = listed.truncated;
    if (listed.statuses.size === 0) {
      if (!noStatusNotified) {
        await safeNotify(notify, TITLE, 'The Orca worktree list returned no workspaceStatus; nothing was synced.');
      }
      noStatusNotified = true;
      return summary;
    }
    noStatusNotified = false;

    const present = links.filter(({ worktreeId }) => listed.statuses.has(worktreeId));
    await runPool(present, { statuses: listed.statuses, config }, summary);

    if (summary.conflictItems.length > 0) {
      const lines = summary.conflictItems.map((c) => `${c.title}: Orca "${c.orca}" vs Basecamp "${c.bc}", ${c.winner} wins`);
      await safeNotify(notify, `${TITLE}: conflict`, lines.join('\n'));
    }
    const { conflictItems, ...result } = summary;
    return { ...result, conflicts: conflictItems.length };
  }

  return {
    async tick() {
      try {
        return await run();
      } catch (error) {
        return { status: 'failed', attempted: 0, failed: 0, synced: 0, conflicts: 0, error: error?.message };
      }
    }
  };
}
