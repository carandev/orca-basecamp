import { buildLink, linkKey } from '../domain/link.mjs';
import { worktreeName } from '../domain/naming.mjs';
import { buildPrompt } from '../domain/prompt.mjs';
import { describeFailure, safeNotify } from './failure.mjs';

const TITLE = 'Basecamp: Start from item';

/**
 * Start from item. The item is always refetched from the source (the request carries only ids), so client text
 * never reaches the worktree name, comment or prompt. Resolves, never throws:
 * `{status: 'linked', worktreeId, name}` | `{status: 'unlinked', name}` | `{status: 'in_flight'}` |
 * `{status: 'failed', error, hint?}`. A second start of the same item while one is running is refused.
 */
export function createStartFromItem({ source, orca, storage, notify, clock }) {
  const inFlight = new Set();

  return async function startFromItem({ type, id, projectId, repoId, agent }) {
    const key = `${type}:${id}`;
    if (inFlight.has(key)) return { status: 'in_flight' };
    inFlight.add(key);
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
          const link = buildLink({
            type: item.type,
            id: item.id,
            projectId: item.projectId,
            appUrl: item.appUrl,
            title: item.title,
            now: clock.now()
          });
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
}

async function findId(orca, name, path) {
  try {
    return await orca.findWorktree({ name, path });
  } catch {
    return null;
  }
}
