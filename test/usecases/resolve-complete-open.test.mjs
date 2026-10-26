import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLinked } from '../../src/usecases/resolve-linked.mjs';
import { createCompleteLinked } from '../../src/usecases/complete-linked.mjs';
import { createOpenLinked } from '../../src/usecases/open-linked.mjs';

const APP_URL = 'https://app.basecamp.com/999/buckets/7/todos/1';
const LINK = { v: 1, type: 'todo', id: 1, projectId: 7, appUrl: APP_URL, title: 'Fix login', createdAt: 1 };

/** Recording fakes. `active` is the resolved worktree (or null); `links` seeds storage. */
const SYNC_ON = { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} };
const SYNC_OFF = { ...SYNC_ON, enabled: false };

function setup({
  active = { worktreeId: 'wt-1', worktreePath: '/w/1' },
  links = { 'link:wt-1': LINK },
  resolveError,
  complete,
  tabError,
  browserError,
  syncConfig = SYNC_ON,
  setStatusError,
  removeWorktreeError
} = {}) {
  const log = { notices: [], completes: [], tabs: [], browser: [], resolves: 0, statusSets: [], worktreeRemovals: [], order: [] };
  const store = new Map(Object.entries(links));
  const deps = {
    orca: {
      resolveActiveWorktree: async () => {
        log.resolves += 1;
        if (resolveError) throw resolveError;
        return active;
      },
      openTab: async (a) => {
        log.tabs.push(a);
        if (tabError) throw tabError;
      },
      setStatus: async (id, status) => {
        log.order.push('setStatus');
        log.statusSets.push([id, status]);
        if (setStatusError) throw setStatusError;
      },
      removeWorktree: async (id) => {
        log.order.push('removeWorktree');
        log.worktreeRemovals.push(id);
        if (removeWorktreeError) throw removeWorktreeError;
      }
    },
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => {
        log.order.push('storage.set');
        store.set(k, v);
      },
      delete: async (k) => void store.delete(k)
    },
    loadSyncConfig: async () => syncConfig,
    clock: { now: () => 1700000000000 },
    source: {
      complete: async (q) => {
        log.completes.push(q);
        if (typeof complete === 'function') return complete(q);
        return complete ?? { status: 'completed' };
      }
    },
    openExternal: async (url) => {
      log.browser.push(url);
      if (browserError) throw browserError;
    },
    notify: async (title, body) => void log.notices.push({ title, body })
  };
  return { deps, log, store };
}

// ---- resolveLinked ---------------------------------------------------------

test('resolveLinked returns the worktree id and the validated link', async () => {
  const { deps } = setup();
  assert.deepEqual(await resolveLinked(deps), { worktreeId: 'wt-1', link: LINK });
});

test('resolveLinked is null with no active worktree, or no link, or a corrupt link', async () => {
  assert.equal(await resolveLinked(setup({ active: null }).deps), null);
  assert.equal(await resolveLinked(setup({ links: {} }).deps), null);
  assert.equal(await resolveLinked(setup({ links: { 'link:wt-1': { v: 9 } } }).deps), null);
});

// ---- Complete --------------------------------------------------------------

test('Complete with no active worktree notifies "no linked item" and makes no call', async () => {
  const { deps, log } = setup({ active: null });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'no_link');
  assert.equal(log.completes.length, 0);
  assert.match(log.notices[0].body, /no linked item/i);
});

test('Complete with no link notifies "no linked item" and makes no call', async () => {
  const { deps, log } = setup({ links: {} });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'no_link');
  assert.equal(log.completes.length, 0);
  assert.equal(log.notices.length, 1);
  assert.match(log.notices[0].body, /no linked item/i);
});

test('Complete spawns once with the link scope and KEEPS the link, now with a completed baseline', async () => {
  const { deps, log, store } = setup();
  const result = await createCompleteLinked(deps)();
  assert.deepEqual(log.completes, [{ type: 'todo', id: 1, projectId: 7 }]);
  assert.equal(result.status, 'completed');
  assert.deepEqual(store.get('link:wt-1'), { ...LINK, v: 2, sync: { orca: 'completed', bc: 'completed', at: 1700000000000 } });
});

test('Complete with sync on sets the Orca status to completed before storing the baseline', async () => {
  const { deps, log } = setup({ syncConfig: SYNC_ON });
  await createCompleteLinked(deps)();
  assert.deepEqual(log.statusSets, [['wt-1', 'completed']]);
  assert.deepEqual(log.order, ['setStatus', 'storage.set']);
});

test('Complete with sync off skips only the Orca set and still writes the baseline', async () => {
  const { deps, log, store } = setup({ syncConfig: SYNC_OFF });
  await createCompleteLinked(deps)();
  assert.deepEqual(log.statusSets, []);
  assert.deepEqual(store.get('link:wt-1').sync, { orca: 'completed', bc: 'completed', at: 1700000000000 });
});

test('Complete carries lastOpenOrca from the previous baseline', async () => {
  const link = { ...LINK, v: 2, sync: { orca: 'in-review', bc: 'open', at: 5, lastOpenOrca: 'in-review' } };
  const { deps, store } = setup({ links: { 'link:wt-1': link } });
  await createCompleteLinked(deps)();
  assert.deepEqual(store.get('link:wt-1').sync, { orca: 'completed', bc: 'completed', at: 1700000000000, lastOpenOrca: 'in-review' });
});

test('Complete already-completed also writes the baseline', async () => {
  const { deps, store } = setup({ complete: { status: 'already' } });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'already');
  assert.equal(store.get('link:wt-1').sync.bc, 'completed');
});

test('Complete: a failing Orca set writes no baseline but still reports the completion', async () => {
  const { deps, log, store } = setup({ setStatusError: new Error('orca down') });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'completed');
  assert.deepEqual(store.get('link:wt-1'), LINK);
  assert.match(log.notices.map((n) => n.body).join(' '), /orca down/);
});

test('Complete: inaccessible writes no baseline and never touches Orca', async () => {
  const { deps, log, store } = setup({ complete: { status: 'inaccessible' } });
  await createCompleteLinked(deps)();
  assert.deepEqual(log.statusSets, []);
  assert.deepEqual(store.get('link:wt-1'), LINK);
});

test('Complete does not recreate a link that vanished before the baseline write', async () => {
  const { deps, store } = setup({
    complete: () => {
      store.delete('link:wt-1');
      return { status: 'completed' };
    }
  });
  await createCompleteLinked(deps)();
  assert.equal(store.has('link:wt-1'), false);
});

test('Complete works for cards too', async () => {
  const card = { ...LINK, type: 'card', id: 55 };
  const { deps, log, store } = setup({ links: { 'link:wt-1': card } });
  await createCompleteLinked(deps)();
  assert.deepEqual(log.completes, [{ type: 'card', id: 55, projectId: 7 }]);
  assert.equal(store.get('link:wt-1').sync.bc, 'completed');
});

test('Complete failure keeps the link, notifies message and hint, spawns exactly once even when retryable', async () => {
  const error = Object.assign(new Error('rate limited'), { code: 'rate_limit', hint: 'wait a minute', retryable: true });
  const { deps, log, store } = setup({
    complete: () => {
      throw error;
    }
  });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'failed');
  assert.equal(log.completes.length, 1);
  assert.equal(store.has('link:wt-1'), true);
  assert.match(log.notices[0].body, /rate limited/);
  assert.match(log.notices[0].body, /wait a minute/);
});

test('Complete: already and inaccessible are reported without throwing and keep the link', async () => {
  for (const status of ['already', 'inaccessible']) {
    const { deps, log, store } = setup({ complete: { status } });
    const result = await createCompleteLinked(deps)();
    assert.equal(result.status, status);
    assert.equal(store.has('link:wt-1'), true);
    assert.equal(log.notices.length, 1);
  }
});

test('Complete reports a resolution failure and never throws', async () => {
  const { deps, log } = setup({ resolveError: new Error('No worktree matches "x"') });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'failed');
  assert.equal(log.completes.length, 0);
  assert.match(log.notices[0].body, /No worktree matches/);
});


test('Complete with removeOnComplete: true removes the worktree after setting status and storing baseline', async () => {
  const { deps, log } = setup({ syncConfig: { ...SYNC_ON, removeOnComplete: true } });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'completed');
  assert.deepEqual(log.worktreeRemovals, ['wt-1']);
  assert.deepEqual(log.order, ['setStatus', 'storage.set', 'removeWorktree']);
});

test('Complete with removeOnComplete: true notifies failure if worktree removal fails', async () => {
  const { deps, log } = setup({
    syncConfig: { ...SYNC_ON, removeOnComplete: true },
    removeWorktreeError: new Error('worktree is dirty')
  });
  const result = await createCompleteLinked(deps)();
  assert.equal(result.status, 'completed');
  assert.match(log.notices[0].body, /worktree not removed: worktree is dirty/);
});

test('Complete with removeOnComplete: false skips worktree removal', async () => {
  const { deps, log } = setup({ syncConfig: { ...SYNC_ON, removeOnComplete: false } });
  await createCompleteLinked(deps)();
  assert.deepEqual(log.worktreeRemovals, []);
});

// ---- Open ------------------------------------------------------------------

test('Open with no active worktree or no link notifies and makes no tab or browser call', async () => {
  for (const over of [{ active: null }, { links: {} }]) {
    const { deps, log } = setup(over);
    const result = await createOpenLinked(deps)();
    assert.equal(result.status, 'no_link');
    assert.deepEqual(log.tabs, []);
    assert.deepEqual(log.browser, []);
    assert.match(log.notices[0].body, /no linked item/i);
  }
});

test('Open creates an Orca tab on the active worktree with the stored appUrl', async () => {
  const { deps, log } = setup();
  const result = await createOpenLinked(deps)();
  assert.deepEqual(log.tabs, [{ worktreeId: 'wt-1', url: APP_URL }]);
  assert.deepEqual(log.browser, []);
  assert.equal(result.status, 'opened');
  assert.equal(result.via, 'orca');
});

test('Open falls back to the OS browser with the same appUrl when the tab fails', async () => {
  const { deps, log } = setup({ tabError: new Error('orca down') });
  const result = await createOpenLinked(deps)();
  assert.deepEqual(log.browser, [APP_URL]);
  assert.equal(result.status, 'opened');
  assert.equal(result.via, 'browser');
});

test('Open reports when both the tab and the browser fail', async () => {
  const { deps, log } = setup({ tabError: new Error('a'), browserError: new Error('no browser') });
  const result = await createOpenLinked(deps)();
  assert.equal(result.status, 'failed');
  assert.match(log.notices[0].body, /no browser/);
});

test('Open refuses a stored URL that is not an https basecamp.com address', async () => {
  const bad = { ...LINK, appUrl: 'https://evil.example.com/x' };
  const { deps, log } = setup({ links: { 'link:wt-1': bad } });
  const result = await createOpenLinked(deps)();
  assert.equal(result.status, 'refused');
  assert.deepEqual(log.tabs, []);
  assert.deepEqual(log.browser, []);
});
