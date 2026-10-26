import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncLinks } from '../../src/usecases/sync-links.mjs';
import { SourceError } from '../../src/adapters/basecamp-cli.mjs';

const NOW = 1700000000000;
const APP_URL = 'https://app.basecamp.com/999/buckets/7/todos/1';

const todo = (id, sync, extra = {}) => ({
  v: sync ? 2 : 1,
  type: 'todo',
  id,
  projectId: 7,
  appUrl: APP_URL,
  title: `Item ${id}`,
  createdAt: 1,
  ...(sync ? { sync } : {}),
  ...extra
});
const card = (id) => ({ ...todo(id), type: 'card', title: `Card ${id}` });
const sync = (orca, bc, extra = {}) => ({ orca, bc, at: 5, ...extra });

/**
 * Recording fakes. `links` is {worktreeId: link}, `orcaStatuses` {worktreeId: status}, `bc` {itemId: state}.
 * `hooks.onState(id)` / `hooks.onComplete(id)` run inside the matching call.
 */
function setup({
  links = {},
  orcaStatuses = {},
  bc = {},
  config,
  truncated = false,
  listError,
  stateError,
  completeError,
  moveError,
  moveResult,
  keysError,
  hooks = {},
  stateDelay = false
} = {}) {
  const log = { host: [], lists: 0, states: [], completes: [], reopens: [], moves: [], orcaSets: [], notices: [] };
  const store = new Map(Object.entries(links).map(([id, l]) => [`link:${id}`, l]));
  if (config !== undefined) store.set('sync:config', config);
  let inflight = 0;
  let maxInflight = 0;
  const deps = {
    storage: {
      keys: async () => {
        log.host.push('keys');
        if (keysError) throw keysError;
        return [...store.keys()];
      },
      get: async (k) => {
        log.host.push(`get:${k}`);
        return store.get(k) ?? null;
      },
      set: async (k, v) => {
        log.host.push(`set:${k}`);
        store.set(k, structuredClone(v));
      },
      delete: async (k) => void store.delete(k)
    },
    source: {
      state: async (ref) => {
        log.states.push(ref);
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        try {
          if (stateDelay) await new Promise((resolve) => setImmediate(resolve));
          if (hooks.onState) await hooks.onState(ref.id);
          const err = typeof stateError === 'function' ? stateError(ref.id) : stateError;
          if (err) throw err;
          return bc[ref.id];
        } finally {
          inflight -= 1;
        }
      },
      complete: async (ref) => {
        log.completes.push(ref);
        if (hooks.onComplete) await hooks.onComplete(ref.id);
        const err = typeof completeError === 'function' ? completeError(ref.id) : completeError;
        if (err) throw err;
        if (completeError === 'inaccessible') return { status: 'inaccessible' };
        bc[ref.id] = 'completed';
        return { status: 'completed' };
      },
      reopen: async (ref) => {
        log.reopens.push(ref);
        bc[ref.id] = 'open';
        return { status: 'reopened' };
      },
      move: async (ref) => {
        log.moves.push(ref);
        if (moveError) throw moveError;
        if (moveResult === 'inaccessible') return { status: 'inaccessible' };
        bc[ref.id] = ref.columnId;
        return { status: 'moved' };
      }
    },
    orca: {
      listWorktreeStatuses: async () => {
        log.host.push('list');
        log.lists += 1;
        if (listError) throw listError;
        return { statuses: new Map(Object.entries(orcaStatuses)), truncated };
      },
      setStatus: async (id, status) => {
        log.orcaSets.push([id, status]);
        orcaStatuses[id] = status;
      }
    },
    notify: async (title, body) => void log.notices.push({ title, body }),
    clock: { now: () => NOW }
  };
  return { deps, log, store, bc, orcaStatuses, maxInflight: () => maxInflight, sync: createSyncLinks(deps) };
}

const stored = (store, id) => store.get(`link:${id}`);

// ---- gates -----------------------------------------------------------------

test('disabled: only the keepalive keys call and the config read happen, nothing is spawned', async () => {
  const s = setup({ config: { enabled: false }, links: { 'wt-1': todo(1) }, orcaStatuses: { 'wt-1': 'completed' }, bc: { 1: 'open' } });
  const result = await s.sync.tick();
  assert.equal(result.status, 'disabled');
  assert.deepEqual(s.log.host, ['keys', 'get:sync:config']);
  assert.equal(s.log.lists, 0);
  assert.equal(s.log.states.length, 0);
  assert.equal(s.log.completes.length + s.log.orcaSets.length, 0);
});

test('no links never reads the worktree list', async () => {
  const none = setup();
  assert.equal((await none.sync.tick()).status, 'ok');
  assert.equal(none.log.lists, 0);
});

test('card links are synced too: the first tick snapshots without any write', async () => {
  const cards = setup({ links: { 'wt-1': card(55) }, orcaStatuses: { 'wt-1': 'in-review' }, bc: { 55: '9' } });
  const result = await cards.sync.tick();
  assert.equal(result.attempted, 1);
  assert.equal(cards.log.lists, 1);
  assert.deepEqual(cards.log.states, [{ type: 'card', id: 55, projectId: 7 }]);
  assert.equal(cards.log.moves.length + cards.log.completes.length + cards.log.orcaSets.length, 0);
  assert.deepEqual(stored(cards.store, 'wt-1').sync, { orca: 'in-review', bc: '9', at: NOW, lastOpenOrca: 'in-review' });
});

test('one worktree list per tick, and only linked items are read from Basecamp', async () => {
  const s = setup({
    links: { 'wt-1': todo(1, sync('in-progress', 'open')), 'wt-2': todo(2, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'in-progress', 'wt-2': 'in-progress', 'wt-x': 'completed' },
    bc: { 1: 'open', 2: 'open' }
  });
  const result = await s.sync.tick();
  assert.equal(s.log.lists, 1);
  assert.deepEqual(s.log.states.map((r) => r.id).sort(), [1, 2]);
  assert.equal(result.attempted, 2);
  assert.equal(result.synced, 0);
});

// ---- baseline --------------------------------------------------------------

test('first sync of a v1 link snapshots both sides and writes nothing', async () => {
  const s = setup({ links: { 'wt-1': todo(1) }, orcaStatuses: { 'wt-1': 'in-review' }, bc: { 1: 'open' } });
  await s.sync.tick();
  assert.equal(s.log.completes.length + s.log.reopens.length + s.log.orcaSets.length, 0);
  assert.deepEqual(stored(s.store, 'wt-1').sync, { orca: 'in-review', bc: 'open', at: NOW, lastOpenOrca: 'in-review' });
  assert.equal(stored(s.store, 'wt-1').v, 2);
});

test('an unchanged baseline is not rewritten', async () => {
  const s = setup({
    links: { 'wt-1': todo(1, sync('in-progress', 'open', { lastOpenOrca: 'in-progress' })) },
    orcaStatuses: { 'wt-1': 'in-progress' },
    bc: { 1: 'open' }
  });
  await s.sync.tick();
  assert.equal(s.log.host.filter((h) => h.startsWith('set:')).length, 0);
});

// ---- one-sided changes -----------------------------------------------------

test('Orca completed: completes the to-do once and stores the new baseline', async () => {
  const s = setup({ links: { 'wt-1': todo(1, sync('in-progress', 'open', { lastOpenOrca: 'in-progress' })) }, orcaStatuses: { 'wt-1': 'completed' }, bc: { 1: 'open' } });
  const result = await s.sync.tick();
  assert.deepEqual(s.log.completes, [{ type: 'todo', id: 1, projectId: 7 }]);
  assert.equal(result.synced, 1);
  assert.deepEqual(stored(s.store, 'wt-1').sync, { orca: 'completed', bc: 'completed', at: NOW, lastOpenOrca: 'in-progress' });
});

test('Orca left completed: reopens the to-do once', async () => {
  const s = setup({
    links: { 'wt-1': todo(1, sync('completed', 'completed', { lastOpenOrca: 'in-review' })) },
    orcaStatuses: { 'wt-1': 'in-progress' },
    bc: { 1: 'completed' }
  });
  await s.sync.tick();
  assert.deepEqual(s.log.reopens, [{ id: 1, projectId: 7 }]);
  assert.equal(s.log.completes.length, 0);
  assert.deepEqual(stored(s.store, 'wt-1').sync, { orca: 'in-progress', bc: 'open', at: NOW, lastOpenOrca: 'in-progress' });
});

test('Basecamp completed: sets Orca to completed; reopened restores lastOpenOrca', async () => {
  const done = setup({ links: { 'wt-1': todo(1, sync('in-progress', 'open')) }, orcaStatuses: { 'wt-1': 'in-progress' }, bc: { 1: 'completed' } });
  await done.sync.tick();
  assert.deepEqual(done.log.orcaSets, [['wt-1', 'completed']]);
  assert.equal(stored(done.store, 'wt-1').sync.bc, 'completed');

  const reopened = setup({
    links: { 'wt-1': todo(1, sync('completed', 'completed', { lastOpenOrca: 'in-review' })) },
    orcaStatuses: { 'wt-1': 'completed' },
    bc: { 1: 'open' }
  });
  await reopened.sync.tick();
  assert.deepEqual(reopened.log.orcaSets, [['wt-1', 'in-review']]);

  const noPrevious = setup({
    links: { 'wt-1': todo(1, sync('completed', 'completed')) },
    orcaStatuses: { 'wt-1': 'completed' },
    bc: { 1: 'open' }
  });
  await noPrevious.sync.tick();
  assert.deepEqual(noPrevious.log.orcaSets, [['wt-1', 'in-progress']]);
});

test('no echo: a second tick after a propagated change writes nothing', async () => {
  const s = setup({ links: { 'wt-1': todo(1, sync('in-progress', 'open')) }, orcaStatuses: { 'wt-1': 'completed' }, bc: { 1: 'open' } });
  await s.sync.tick();
  await s.sync.tick();
  assert.equal(s.log.completes.length, 1);
  assert.equal(s.log.reopens.length + s.log.orcaSets.length, 0);
});

// ---- conflicts -------------------------------------------------------------

test('orca-wins conflict overwrites Basecamp and sends one aggregated notice for several conflicts', async () => {
  const s = setup({
    config: { enabled: true, conflictRule: 'orca-wins', statusToColumn: {} },
    links: { 'wt-1': todo(1, sync('in-progress', 'open')), 'wt-2': todo(2, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'in-review', 'wt-2': 'in-review' },
    bc: { 1: 'completed', 2: 'completed' }
  });
  const result = await s.sync.tick();
  assert.equal(result.conflicts, 2);
  assert.equal(s.log.reopens.length, 2);
  assert.equal(s.log.orcaSets.length, 0);
  assert.equal(s.log.notices.length, 1);
  assert.match(s.log.notices[0].body, /Item 1/);
  assert.match(s.log.notices[0].body, /Item 2/);
});

test('basecamp-wins conflict overwrites Orca', async () => {
  const s = setup({
    config: { enabled: true, conflictRule: 'basecamp-wins', statusToColumn: {} },
    links: { 'wt-1': todo(1, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'in-review' },
    bc: { 1: 'completed' }
  });
  await s.sync.tick();
  assert.deepEqual(s.log.orcaSets, [['wt-1', 'completed']]);
  assert.equal(s.log.reopens.length + s.log.completes.length, 0);
  assert.equal(s.log.notices.length, 1);
});

// ---- Orca read -------------------------------------------------------------

test('a truncated list notifies once per episode and still syncs the returned set', async () => {
  const s = setup({
    truncated: true,
    links: { 'wt-1': todo(1, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'completed' },
    bc: { 1: 'open' }
  });
  await s.sync.tick();
  await s.sync.tick();
  assert.equal(s.log.completes.length, 1);
  const truncatedNotices = s.log.notices.filter((n) => /truncated|partial|first/i.test(n.body));
  assert.equal(truncatedNotices.length, 1);
});

test('rows without any workspaceStatus notify once and write nothing', async () => {
  const s = setup({ links: { 'wt-1': todo(1, sync('in-progress', 'open')) }, orcaStatuses: {}, bc: { 1: 'completed' } });
  const first = await s.sync.tick();
  await s.sync.tick();
  assert.equal(first.synced, 0);
  assert.equal(s.log.states.length, 0);
  assert.equal(s.log.orcaSets.length + s.log.completes.length, 0);
  assert.equal(s.log.notices.length, 1);
  assert.match(s.log.notices[0].body, /workspaceStatus/);
});

test('a worktree absent from the list is skipped and its link is kept', async () => {
  const s = setup({
    links: { 'wt-1': todo(1, sync('in-progress', 'open')), 'wt-2': todo(2, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'in-progress' },
    bc: { 1: 'open', 2: 'open' }
  });
  const result = await s.sync.tick();
  assert.deepEqual(s.log.states.map((r) => r.id), [1]);
  assert.equal(result.attempted, 1);
  assert.ok(stored(s.store, 'wt-2'));
});

test('a failing worktree list is orca_failed, notified once, and nothing else runs', async () => {
  const s = setup({ listError: new Error('orca down'), links: { 'wt-1': todo(1, sync('a', 'open')) } });
  const first = await s.sync.tick();
  await s.sync.tick();
  assert.equal(first.status, 'orca_failed');
  assert.equal(s.log.states.length, 0);
  assert.equal(s.log.notices.length, 1);
  assert.match(s.log.notices[0].body, /orca down/);
});

// ---- concurrency and isolation --------------------------------------------

test('at most 3 items are processed at the same time', async () => {
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const s = setup({
    stateDelay: true,
    links: Object.fromEntries(ids.map((i) => [`wt-${i}`, todo(i, sync('in-progress', 'open'))])),
    orcaStatuses: Object.fromEntries(ids.map((i) => [`wt-${i}`, 'in-progress'])),
    bc: Object.fromEntries(ids.map((i) => [i, 'open']))
  });
  const result = await s.sync.tick();
  assert.equal(result.attempted, 7);
  assert.equal(s.maxInflight(), 3);
});

test('item 2 fails: items 1 and 3 sync, one attempt for 2, its baseline is unchanged, one notice, no repeat', async () => {
  const boom = Object.assign(new SourceError({ code: 'api', message: 'write failed', hint: 'later', retryable: true }));
  const s = setup({
    completeError: (id) => (id === 2 ? boom : undefined),
    links: Object.fromEntries([1, 2, 3].map((i) => [`wt-${i}`, todo(i, sync('in-progress', 'open'))])),
    orcaStatuses: { 'wt-1': 'completed', 'wt-2': 'completed', 'wt-3': 'completed' },
    bc: { 1: 'open', 2: 'open', 3: 'open' }
  });
  const result = await s.sync.tick();
  assert.equal(s.log.completes.filter((r) => r.id === 2).length, 1);
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 1);
  assert.equal(stored(s.store, 'wt-1').sync.bc, 'completed');
  assert.equal(stored(s.store, 'wt-3').sync.bc, 'completed');
  assert.deepEqual(stored(s.store, 'wt-2').sync, sync('in-progress', 'open'));
  assert.equal(s.log.notices.length, 1);
  assert.match(s.log.notices[0].body, /write failed/);
  await s.sync.tick();
  assert.equal(s.log.notices.length, 1);
});

test('an inaccessible completion is a failure: baseline unchanged and notified', async () => {
  const s = setup({
    completeError: 'inaccessible',
    links: { 'wt-1': todo(1, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'completed' },
    bc: { 1: 'open' }
  });
  const result = await s.sync.tick();
  assert.equal(result.failed, 1);
  assert.deepEqual(stored(s.store, 'wt-1').sync, sync('in-progress', 'open'));
  assert.equal(s.log.notices.length, 1);
});

test('each processed item re-reads its link from the host after the worktree list', async () => {
  const s = setup({
    links: { 'wt-1': todo(1, sync('in-progress', 'open')), 'wt-2': todo(2, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'in-progress', 'wt-2': 'in-progress' },
    bc: { 1: 'open', 2: 'open' }
  });
  await s.sync.tick();
  assert.equal(s.log.host[0], 'keys');
  const listAt = s.log.host.indexOf('list');
  for (const key of ['get:link:wt-1', 'get:link:wt-2']) {
    assert.ok(s.log.host.indexOf(key, listAt) > listAt, `${key} read after the list`);
  }
});

// ---- race with removal -----------------------------------------------------

test('a link removed while its write is in flight is not recreated', async () => {
  const s = setup({
    links: { 'wt-1': todo(1, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'completed' },
    bc: { 1: 'open' },
    hooks: { onComplete: async () => void s.store.delete('link:wt-1') }
  });
  await s.sync.tick();
  assert.equal(s.store.has('link:wt-1'), false);
});

test('a link removed before the first snapshot is not recreated either', async () => {
  const s = setup({
    links: { 'wt-1': todo(1) },
    orcaStatuses: { 'wt-1': 'in-review' },
    bc: { 1: 'open' },
    hooks: { onState: async () => void s.store.delete('link:wt-1') }
  });
  await s.sync.tick();
  assert.equal(s.store.has('link:wt-1'), false);
});

// ---- fatal -----------------------------------------------------------------

test('cli_not_found or an auth error stops the pool and is reported as fatal without a per-item notice', async () => {
  for (const code of ['cli_not_found', 'auth_required', 'unauthorized']) {
    const ids = [1, 2, 3, 4, 5, 6];
    const s = setup({
      stateDelay: true,
      stateError: new SourceError({ code, message: 'nope' }),
      links: Object.fromEntries(ids.map((i) => [`wt-${i}`, todo(i, sync('in-progress', 'open'))])),
      orcaStatuses: Object.fromEntries(ids.map((i) => [`wt-${i}`, 'in-progress'])),
      bc: {}
    });
    const result = await s.sync.tick();
    assert.equal(result.fatal.code, code);
    assert.ok(s.log.states.length <= 3, `${code}: pool stopped (${s.log.states.length} reads)`);
    assert.equal(s.log.notices.length, 0);
  }
});

test('a non-fatal error code does not report fatal', async () => {
  const s = setup({
    stateError: new SourceError({ code: 'rate_limit', message: 'slow down', retryable: true }),
    links: { 'wt-1': todo(1, sync('in-progress', 'open')) },
    orcaStatuses: { 'wt-1': 'in-progress' }
  });
  const result = await s.sync.tick();
  assert.equal(result.fatal, undefined);
  assert.equal(result.failed, 1);
});

test('tick never throws even when the host keys call fails', async () => {
  const s = setup({ keysError: new Error('host gone') });
  const result = await s.sync.tick();
  assert.equal(result.status, 'failed');
});

// ---- cards -----------------------------------------------------------------

const MAP = { enabled: true, conflictRule: 'orca-wins', statusToColumn: { 7: { todo: '8', 'in-progress': '8', 'in-review': '9' } } };
const cardSetup = ({ base, orca, bc, ...rest }) =>
  setup({ config: MAP, links: { 'wt-1': { ...card(55), v: 2, sync: sync(...base) } }, orcaStatuses: { 'wt-1': orca }, bc: { 55: bc }, ...rest });

test('card: a mapped Orca status moves the card to its column and stores the baseline', async () => {
  const s = cardSetup({ base: ['in-progress', '8'], orca: 'in-review', bc: '8' });
  const result = await s.sync.tick();
  assert.deepEqual(s.log.moves, [{ id: 55, projectId: 7, columnId: '9' }]);
  assert.equal(s.log.completes.length, 0);
  assert.equal(result.synced, 1);
  assert.equal(stored(s.store, 'wt-1').sync.bc, '9');
  await s.sync.tick();
  assert.equal(s.log.moves.length, 1);
});

test('card: Orca completed marks the card done (complete), never a move', async () => {
  const s = cardSetup({ base: ['in-review', '9'], orca: 'completed', bc: '9' });
  await s.sync.tick();
  assert.deepEqual(s.log.completes, [{ type: 'card', id: 55, projectId: 7 }]);
  assert.equal(s.log.moves.length, 0);
  assert.equal(stored(s.store, 'wt-1').sync.bc, 'completed');
});

test('card: an unmapped Orca status is ignored', async () => {
  const s = cardSetup({ base: ['in-review', '9'], orca: 'my-custom', bc: '9' });
  await s.sync.tick();
  assert.equal(s.log.moves.length + s.log.completes.length + s.log.orcaSets.length, 0);
});

test('card: leaving completed to an unmapped status leaves the card where it is', async () => {
  const s = cardSetup({ base: ['completed', 'completed'], orca: 'my-custom', bc: 'completed' });
  await s.sync.tick();
  assert.equal(s.log.moves.length + s.log.completes.length + s.log.orcaSets.length, 0);
});

test('card: several statuses on one column keep the current Orca status', async () => {
  const same = cardSetup({ base: ['todo', '8'], orca: 'todo', bc: '9' });
  await same.sync.tick();
  assert.deepEqual(same.log.orcaSets, [['wt-1', 'in-review']]);
  const kept = cardSetup({ base: ['in-review', '9'], orca: 'in-review', bc: '8' });
  await kept.sync.tick();
  assert.deepEqual(kept.log.orcaSets, [['wt-1', 'todo']]);
  const stay = cardSetup({ base: ['todo', '9'], orca: 'in-progress', bc: '8' });
  await stay.sync.tick();
  assert.equal(stay.log.moves.length + stay.log.orcaSets.length, 0);
});

test('card: a card in an unmapped column leaves Orca unchanged', async () => {
  const s = cardSetup({ base: ['in-review', '9'], orca: 'in-review', bc: '77' });
  await s.sync.tick();
  assert.equal(s.log.moves.length + s.log.completes.length + s.log.orcaSets.length, 0);
});

test('card: a column change in Basecamp sets Orca to the first status mapped to it', async () => {
  const s = cardSetup({ base: ['in-review', '9'], orca: 'in-review', bc: '8' });
  await s.sync.tick();
  assert.deepEqual(s.log.orcaSets, [['wt-1', 'todo']]);
  assert.equal(s.log.moves.length, 0);
  assert.equal(stored(s.store, 'wt-1').sync.orca, 'todo');
});

test('card: Basecamp done sets Orca completed; a project without a mapping still tracks done', async () => {
  const done = cardSetup({ base: ['in-review', '9'], orca: 'in-review', bc: 'completed' });
  await done.sync.tick();
  assert.deepEqual(done.log.orcaSets, [['wt-1', 'completed']]);
  const none = setup({ links: { 'wt-1': { ...card(55), v: 2, sync: sync('in-review', '9') } }, orcaStatuses: { 'wt-1': 'completed' }, bc: { 55: '9' } });
  await none.sync.tick();
  assert.equal(none.log.completes.length, 1);
});

test('card: an inaccessible move is a failure and leaves the baseline unchanged', async () => {
  const s = cardSetup({ base: ['in-progress', '8'], orca: 'in-review', bc: '8', moveResult: 'inaccessible' });
  const result = await s.sync.tick();
  assert.equal(result.failed, 1);
  assert.deepEqual(stored(s.store, 'wt-1').sync, sync('in-progress', '8'));
  assert.equal(s.log.notices.length, 1);
});

test('card: a move error (several card tables) is notified once with its message', async () => {
  const boom = new SourceError({ code: 'ambiguous', message: 'Multiple card tables', retryable: false });
  const s = cardSetup({ base: ['in-progress', '8'], orca: 'in-review', bc: '8', moveError: boom });
  await s.sync.tick();
  await s.sync.tick();
  assert.equal(s.log.moves.length, 2);
  assert.equal(s.log.notices.length, 1);
  assert.match(s.log.notices[0].body, /Multiple card tables/);
});
