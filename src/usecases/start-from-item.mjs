import { buildLink, linkKey, withSync } from '../domain/link.mjs';
import { worktreeName } from '../domain/naming.mjs';
import { buildPrompt } from '../domain/prompt.mjs';
import { reconcile } from '../domain/sync.mjs';
import { describeFailure, safeNotify } from './failure.mjs';

const TITLE = 'Basecamp: Start from item';
const SET_TIMEOUT_MS = 10_000;
const START_BUDGET_MS = 28_000;
const MIN_SET_BUDGET_MS = 2_000;

/**
 * Start from item. The item is always refetched from the source (the request carries only ids), so client text
 * never reaches the worktree name, comment or prompt. Resolves, never throws:
 * `{status: 'linked', worktreeId, name}` | `{status: 'unlinked', name}` | `{status: 'in_flight'}` |
 * `{status: 'failed', error, hint?}`. A second start of the same item while one is running is refused.
 * With sync on, the new worktree also gets its initial Orca status (best effort: a failure only notifies and
 * leaves the link without a baseline, so the first tick snapshots instead).
 */
export function createStartFromItem({ source, orca, storage, notify, clock, loadSyncConfig }) {
  const inFlight = new Set();

  return async function startFromItem({ type, id, projectId, repoId, agent }) {
    const key = `${type}:${id}`;
    if (inFlight.has(key)) return { status: 'in_flight' };
    inFlight.add(key);
    const startedAt = clock.now();
    try {
      let item;
      try {
        item = await source.get({ type, id, projectId });
      } catch (error) {
        await safeNotify(notify, `${TITLE} failed`, describeFailure(error));
        return { status: 'failed', error: error.message, hint: error.hint };
      }

      const name = worktreeName(item.id, item.title);
      let created;
      try {
        created = await orca.createWorktree({
          repoId,
          name,
          comment: `${item.title} ${item.appUrl}`,
          agent,
          prompt: buildPrompt(item.title, item.description)
        });
      } catch (error) {
        await safeNotify(notify, `${TITLE} failed`, describeFailure(error));
        return { status: 'failed', error: error.message };
      }

      const worktreeId = created?.worktreeId ?? (await findId(orca, name, created?.path));
      if (worktreeId) {
        try {
          let link = buildLink({
            type: item.type,
            id: item.id,
            projectId: item.projectId,
            appUrl: item.appUrl,
            title: item.title,
            now: clock.now()
          });
          const baseline = await setInitialStatus({ item, worktreeId, startedAt });
          if (baseline) link = withSync(link, baseline);
          await storage.set(linkKey(worktreeId), link);
          await safeNotify(notify, TITLE, `Created ${name} linked to: ${item.title}`);
          return { status: 'linked', worktreeId, name };
        } catch {
          // fall through to "created but not linked"
        }
      }
      await safeNotify(notify, TITLE, `Worktree ${name} was created but not linked to "${item.title}" (${item.appUrl}).`);
      return { status: 'unlinked', name };
    } finally {
      inFlight.delete(key);
    }
  };

  /** Sets the mapped Orca status and returns the baseline for it; null when nothing was set. Never throws. */
  async function setInitialStatus({ item, worktreeId, startedAt }) {
    let config;
    try {
      config = await loadSyncConfig();
    } catch {
      return null;
    }
    if (!config?.enabled) return null;
    const status = initialStatus(item, config.statusToColumn?.[item.projectId]);
    if (status === null) return null;
    const timeoutMs = Math.min(SET_TIMEOUT_MS, START_BUDGET_MS - (clock.now() - startedAt));
    if (timeoutMs < MIN_SET_BUDGET_MS) {
      await safeNotify(notify, TITLE, `Skipped the initial Orca status "${status}": the start ran out of time. The next sync will pick it up.`);
      return null;
    }
    try {
      await orca.setStatus(worktreeId, status, { timeoutMs });
    } catch (error) {
      await safeNotify(notify, TITLE, `Could not set the Orca status to "${status}": ${describeFailure(error)}`);
      return null;
    }
    return { ...reconcile({ kind: item.type, baseline: null, orca: status, bc: item.state }).baseline, at: clock.now() };
  }
}

/** To-do: in-progress, or completed when already done. Card: completed when done, else the first status mapped to its column. */
function initialStatus(item, projectMap = {}) {
  if (item.state === 'completed') return 'completed';
  if (item.type === 'todo') return item.state === 'open' ? 'in-progress' : null;
  return Object.keys(projectMap).find((status) => projectMap[status] === item.state) ?? null;
}

async function findId(orca, name, path) {
  try {
    return await orca.findWorktree({ name, path });
  } catch {
    return null;
  }
}
