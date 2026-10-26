import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import activate, { deactivate } from '../main.mjs';

const CONFIG_FILE = '/cfg/orca-basecamp/config.json';
const ok = (stdout) => ({ stdout, stderr: '', code: 0, timedOut: false });
const envelope = (data) => ok(JSON.stringify({ ok: true, data }));
const LINK = {
  v: 1,
  type: 'todo',
  id: 5,
  projectId: 7,
  appUrl: 'https://app.basecamp.com/a/buckets/7/todos/5',
  title: 'Fix login',
  createdAt: 1
};
const SYNC_OFF = { enabled: false, conflictRule: 'orca-wins', removeOnComplete: false, statusToColumn: {} };
const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'));

/** Records timers instead of running them; `fire(ms)` runs the callbacks registered with that delay. */
function fakeTimers() {
  const timers = [];
  const handle = (kind, fn, ms) => {
    const h = { kind, fn, ms, cleared: false, unref() { return this; } };
    timers.push(h);
    return h;
  };
  return {
    api: {
      setInterval: (fn, ms) => handle('interval', fn, ms),
      setTimeout: (fn, ms) => handle('timeout', fn, ms),
      clearInterval: (h) => void (h.cleared = true),
      clearTimeout: (h) => void (h.cleared = true)
    },
    live: () => timers.filter((t) => !t.cleared),
    fire: (ms) => timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => t.fn())
  };
}

function setup({ files = {}, replies = [], context = null, storage = {}, worktrees = [], listHangs = false } = {}) {
  const fake = fakeTimers();
  const handlers = {};
  const events = {};
  const logs = [];
  const hostCalls = [];
  const store = new Map(Object.entries(storage));
  const orca = {
    log: (m) => logs.push(m),
    events: { on: (name, fn) => (events[name] = fn) },
    commands: { register: (id, fn) => (handlers[id] = fn) },
    host: {
      call: async (name, payload) => {
        hostCalls.push([name, payload]);
        if (name === 'workspace.readContext') return context;
        if (name === 'storage.get') return { value: store.get(payload.key) ?? null };
        if (name === 'storage.set') store.set(payload.key, payload.value);
        if (name === 'storage.delete') store.delete(payload.key);
        if (name === 'storage.keys') return { keys: [...store.keys()] };
      }
    }
  };
  const calls = [];
  const orcaCalls = [];
  const opened = [];
  const server = {
    stops: 0,
    created: 0,
    sessions: [],
    start: async () => ({ url: 'http://127.0.0.1:5555/?token=t' }),
    createLinkSession: (target) => {
      server.sessions.push(target);
      return 'sess1';
    },
    stop: async () => void (server.stops += 1)
  };
  const deps = {
    fs: { readFile: async (p) => (p in files ? files[p] : null) },
    configFile: CONFIG_FILE,
    env: { PATH: '/bin', USERPROFILE: '/u' },
    spawner: {
      run: async (file, args, opts) => {
        calls.push({ file, args, opts });
        return replies[calls.length - 1];
      }
    },
    orcaCli: async (args) => {
      orcaCalls.push(args);
      if (args[0] === 'terminal') return { terminal: { worktreeId: 'wt1', worktreePath: '/w' } };
      if (args[0] === 'worktree' && args[1] === 'list') {
        if (listHangs) return new Promise(() => {});
        return { worktrees };
      }
      return {};
    },
    openExternal: async (url) => opened.push(url),
    createServer: () => {
      server.created += 1;
      return server;
    },
    clock: { now: () => 1 },
    timers: fake.api
  };
  return { orca, deps, handlers, events, logs, hostCalls, calls, orcaCalls, opened, store, server, fake };
}
const ACTIVE = { branch: 'b', displayName: 'wt', terminals: [{ id: 't0' }] };
const notes = (s) => s.hostCalls.filter(([n]) => n === 'notifications.show').map(([, p]) => p);

test('registers exactly the manifest commands (including sync-now), all global, and the manifest events', () => {
  const s = setup();
  activate(s.orca, s.deps);
  const declared = manifest.contributes.commands;
  assert.deepEqual(Object.keys(s.handlers).sort(), declared.map((c) => c.id).sort());
  assert.ok(declared.every((c) => c.context === 'global'));
  assert.deepEqual(Object.keys(s.events), manifest.contributes.events.map((e) => e.on));
  assert.ok('sync-now' in s.handlers);
  assert.deepEqual(manifest.contributes.events.map((e) => e.on), ['worktree.removed', 'agent.status.changed']);
});

test('activate starts the poller: one interval and one initial timeout, and nothing runs yet', () => {
  const s = setup();
  activate(s.orca, s.deps);
  assert.deepEqual(s.fake.live().map((t) => [t.kind, t.ms]), [['interval', 60_000], ['timeout', 5_000]]);
  assert.equal(s.calls.length, 0);
});

test('agent.status.changed returns synchronously and never starts a second poller', () => {
  const s = setup();
  activate(s.orca, s.deps);
  const result = s.events['agent.status.changed']({});
  assert.equal(result instanceof Promise, false);
  assert.equal(s.fake.live().filter((t) => t.kind === 'interval').length, 1);
});

test('agent.status.changed restarts a stopped poller', () => {
  const s = setup();
  activate(s.orca, s.deps);
  deactivate();
  assert.equal(s.fake.live().length, 0);
  s.events['agent.status.changed']({});
  assert.equal(s.fake.live().filter((t) => t.kind === 'interval').length, 1);
});

test('deactivate stops the poller and the picker server, and can be called twice', async () => {
  const s = setup();
  activate(s.orca, s.deps);
  await s.handlers.start();
  deactivate();
  assert.equal(s.fake.live().length, 0);
  assert.equal(s.server.stops, 1);
  assert.doesNotThrow(() => deactivate());
});

test('diagnose notifies the summary and logs it', async () => {
  const s = setup({ replies: [ok('basecamp 9.9\n'), ok('{"ok":true,"data":{"source":"oauth"}}')] });
  activate(s.orca, s.deps);
  await s.handlers.diagnose();
  const [note] = notes(s);
  assert.equal(note.title, 'Basecamp: Diagnose');
  assert.match(note.body, /basecamp 9\.9/);
  assert.match(note.body, /source: oauth/);
  assert.match(s.logs.join('\n'), /source: oauth/);
});

test('diagnose uses basecampBin and basecampEnv from the config file', async () => {
  const files = { [CONFIG_FILE]: JSON.stringify({ basecampBin: '/opt/bc', basecampEnv: { BASECAMP_PROFILE: 'w' } }) };
  const s = setup({ files, replies: [ok('v\n'), ok('{"ok":true,"data":{}}')] });
  activate(s.orca, s.deps);
  await s.handlers.diagnose();
  assert.equal(s.calls[0].file, '/opt/bc');
  assert.equal(s.calls[0].opts.env.BASECAMP_PROFILE, 'w');
});

test('a broken config file is notified, never thrown', async () => {
  const s = setup({ files: { [CONFIG_FILE]: '{nope' } });
  activate(s.orca, s.deps);
  await s.handlers.diagnose();
  assert.equal(s.calls.length, 0);
  assert.equal(notes(s)[0].title, 'Basecamp failed');
  assert.match(notes(s)[0].body, /Invalid JSON/);
});

test('notification body is clamped to 1000 chars', async () => {
  const files = { [CONFIG_FILE]: JSON.stringify({ basecampBin: `/${'x'.repeat(5000)}` }) };
  const s = setup({ files, replies: [ok('v\n'), ok('{"ok":true,"data":{}}')] });
  activate(s.orca, s.deps);
  await s.handlers.diagnose();
  assert.equal(notes(s)[0].body.length, 1000);
});

test('start opens the picker through the server and notifies its url', async () => {
  const s = setup();
  activate(s.orca, s.deps);
  await s.handlers.start();
  assert.deepEqual(s.opened, ['http://127.0.0.1:5555/?token=t']);
  assert.match(notes(s)[0].body, /5555/);
});

test('the manifest declares the link command, global, and main registers it', () => {
  const s = setup();
  activate(s.orca, s.deps);
  const declared = manifest.contributes.commands.find((c) => c.id === 'link');
  assert.deepEqual(declared, { id: 'link', title: 'Basecamp: Link item to this worktree', context: 'global' });
  assert.equal(typeof s.handlers.link, 'function');
});

test('link without an active worktree notifies, spawns nothing and starts no server', async () => {
  const s = setup({ context: null });
  activate(s.orca, s.deps);
  await s.handlers.link();
  assert.deepEqual(notes(s).map((n) => n.body), ['Open a worktree first']);
  assert.equal(s.server.created, 0);
  assert.deepEqual(s.server.sessions, []);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.orcaCalls, []);
  assert.deepEqual(s.opened, []);
});

test('link with an active worktree opens a link-mode tab on that worktree, bound to a new session', async () => {
  const s = setup({ context: ACTIVE });
  activate(s.orca, s.deps);
  await s.handlers.link();
  assert.deepEqual(s.server.sessions, [{ worktreeId: 'wt1', displayName: 'wt' }]);
  const tab = s.orcaCalls.find((a) => a[0] === 'tab');
  assert.deepEqual(tab, ['tab', 'create', '--worktree', 'id:wt1', '--url', 'http://127.0.0.1:5555/?token=t&mode=link&session=sess1']);
  assert.deepEqual(s.opened, []);
  assert.equal(s.calls.length, 0);
});

test('link reuses the picker server that start created', async () => {
  const s = setup({ context: ACTIVE });
  activate(s.orca, s.deps);
  await s.handlers.start();
  await s.handlers.link();
  assert.equal(s.server.created, 1);
});

test('open-item and complete without a linked worktree notify and spawn nothing', async () => {
  const s = setup({ context: null });
  activate(s.orca, s.deps);
  await s.handlers['open-item']();
  await s.handlers.complete();
  assert.equal(notes(s).length, 2);
  assert.ok(notes(s).every((n) => /No linked item/.test(n.body)));
  assert.equal(s.calls.length, 0);
  assert.equal(s.opened.length, 0);
});

test('open-item opens the linked url in an Orca tab', async () => {
  const s = setup({ context: ACTIVE, storage: { 'link:wt1': LINK } });
  activate(s.orca, s.deps);
  await s.handlers['open-item']();
  assert.deepEqual(s.orcaCalls.at(-1), ['tab', 'create', '--worktree', 'id:wt1', '--url', LINK.appUrl]);
});

test('complete runs the CLI for the linked item, keeps the link and stores a completed baseline', async () => {
  const s = setup({ context: ACTIVE, storage: { 'link:wt1': LINK }, replies: [envelope({})] });
  activate(s.orca, s.deps);
  await s.handlers.complete();
  assert.deepEqual(s.calls[0].args, ['todos', 'complete', '5', '--in', '7', '--json']);
  assert.deepEqual(s.orcaCalls.at(-1), ['worktree', 'set', '--worktree', 'id:wt1', '--workspace-status', 'completed']);
  assert.deepEqual(s.store.get('link:wt1').sync, { orca: 'completed', bc: 'completed', at: 1 });
  assert.match(notes(s).at(-1).body, /Completed: Fix login/);
});

test('complete with sync disabled skips the Orca set but still stores the baseline', async () => {
  const s = setup({ context: ACTIVE, storage: { 'link:wt1': LINK, 'sync:config': SYNC_OFF }, replies: [envelope({})] });
  activate(s.orca, s.deps);
  await s.handlers.complete();
  assert.equal(s.orcaCalls.some((a) => a[0] === 'worktree' && a[1] === 'set'), false);
  assert.deepEqual(s.store.get('link:wt1').sync, { orca: 'completed', bc: 'completed', at: 1 });
});

test('complete keeps the link when the CLI fails and spawns once', async () => {
  const failed = ok(JSON.stringify({ ok: false, error: 'boom', code: 'api', hint: 'later', retryable: true }));
  const s = setup({ context: ACTIVE, storage: { 'link:wt1': LINK }, replies: [failed, failed] });
  activate(s.orca, s.deps);
  await s.handlers.complete();
  assert.equal(s.calls.length, 1);
  assert.equal(s.store.has('link:wt1'), true);
  assert.match(notes(s).at(-1).body, /boom/);
  assert.match(notes(s).at(-1).body, /later/);
});

test('worktree.removed completes the linked item and deletes the link', async () => {
  const s = setup({ storage: { 'link:wt1': LINK }, replies: [envelope({})] });
  activate(s.orca, s.deps);
  await s.events['worktree.removed']({ worktreeId: 'wt1', path: '/w' });
  assert.deepEqual(s.calls[0].args, ['todos', 'complete', '5', '--in', '7', '--json']);
  assert.equal(s.store.has('link:wt1'), false);
});

test('worktree.removed completes and deletes the link even when sync is disabled', async () => {
  const s = setup({ storage: { 'link:wt1': LINK, 'sync:config': SYNC_OFF }, replies: [envelope({})] });
  activate(s.orca, s.deps);
  await s.events['worktree.removed']({ worktreeId: 'wt1' });
  assert.deepEqual(s.calls[0].args, ['todos', 'complete', '5', '--in', '7', '--json']);
  assert.equal(s.store.has('link:wt1'), false);
});

test('worktree.removed never throws: unlinked is a no-op and a broken config still deletes the link', async () => {
  const unlinked = setup();
  activate(unlinked.orca, unlinked.deps);
  await unlinked.events['worktree.removed']({ worktreeId: 'nope' });
  assert.equal(unlinked.calls.length, 0);
  assert.equal(notes(unlinked).length, 0);

  const broken = setup({ files: { [CONFIG_FILE]: '{nope' }, storage: { 'link:wt1': LINK } });
  activate(broken.orca, broken.deps);
  await assert.doesNotReject(broken.events['worktree.removed']({ worktreeId: 'wt1' }));
  assert.equal(broken.store.has('link:wt1'), false);
  assert.match(notes(broken)[0].body, /Invalid JSON/);
});

// ---- sync-now --------------------------------------------------------------

const SHOW = envelope({ id: 5, title: 'Fix login', app_url: LINK.appUrl, completed: false, bucket: { id: 7, name: 'P' } });

test('sync-now runs one tick: reads the item, propagates Orca completed to Basecamp, sends no notification', async () => {
  const baseline = { ...LINK, v: 2, sync: { orca: 'in-progress', bc: 'open', at: 1, lastOpenOrca: 'in-progress' } };
  const s = setup({
    storage: { 'link:wt1': baseline },
    worktrees: [{ id: 'wt1', workspaceStatus: 'completed' }],
    replies: [SHOW, envelope({})]
  });
  activate(s.orca, s.deps);
  await s.handlers['sync-now']();
  assert.deepEqual(s.calls.map((c) => c.args.slice(0, 3)), [['todos', 'show', '5'], ['todos', 'complete', '5']]);
  assert.equal(s.store.get('link:wt1').sync.bc, 'completed');
  assert.equal(notes(s).length, 0);
  assert.ok(s.hostCalls.some(([n]) => n === 'storage.keys'));
});

test('sync-now with sync disabled writes nothing and spawns nothing', async () => {
  const s = setup({
    storage: { 'link:wt1': LINK, 'sync:config': SYNC_OFF },
    worktrees: [{ id: 'wt1', workspaceStatus: 'completed' }]
  });
  activate(s.orca, s.deps);
  await s.handlers['sync-now']();
  assert.equal(s.calls.length, 0);
  assert.equal(s.orcaCalls.length, 0);
  assert.equal(notes(s).length, 0);
});

test('sync-now gives up waiting after 20 s without notifying', async () => {
  const s = setup({ storage: { 'link:wt1': LINK }, listHangs: true });
  activate(s.orca, s.deps);
  const pending = s.handlers['sync-now']();
  await new Promise((resolve) => setImmediate(resolve));
  s.fake.fire(20_000);
  await pending;
  assert.equal(notes(s).length, 0);
});

test('the picker server gets the sync config port and onConfigSaved restarts a stopped poller', async () => {
  const s = setup({ storage: { 'sync:config': SYNC_OFF } });
  let args;
  activate(s.orca, { ...s.deps, createServer: (a) => ((args = a), s.server) });
  await s.handlers.start();
  assert.equal(typeof args.syncConfig.get, 'function');
  assert.equal(typeof args.syncConfig.save, 'function');
  assert.deepEqual(await args.syncConfig.get(), SYNC_OFF);
  assert.equal(typeof args.source.columns, 'function');
  assert.equal(typeof args.onConfigSaved, 'function');
  deactivate();
  assert.equal(s.fake.live().length, 0);
  args.onConfigSaved();
  assert.equal(s.fake.live().filter((t) => t.kind === 'interval').length, 1);
});

test('link falls back to the worktree folder name when Orca gives no display name', async () => {
  const s = setup({ context: { ...ACTIVE, displayName: undefined } });
  activate(s.orca, s.deps);
  await s.handlers.link();
  assert.deepEqual(s.server.sessions, [{ worktreeId: 'wt1', displayName: 'w' }]);
});
