import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import activate from '../main.mjs';

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
const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'));

function setup({ files = {}, replies = [], context = null, storage = {} } = {}) {
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
      }
    }
  };
  const calls = [];
  const orcaCalls = [];
  const opened = [];
  const server = { starts: 0, start: async () => ({ url: 'http://127.0.0.1:5555/?token=t' }) };
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
      return {};
    },
    openExternal: async (url) => opened.push(url),
    createServer: () => server,
    clock: { now: () => 1 }
  };
  return { orca, deps, handlers, events, logs, hostCalls, calls, orcaCalls, opened, store };
}
const ACTIVE = { branch: 'b', displayName: 'wt', terminals: [{ id: 't0' }] };
const notes = (s) => s.hostCalls.filter(([n]) => n === 'notifications.show').map(([, p]) => p);

test('registers exactly the manifest commands, all global, and the worktree.removed handler', () => {
  const s = setup();
  activate(s.orca, s.deps);
  const declared = manifest.contributes.commands;
  assert.deepEqual(Object.keys(s.handlers).sort(), declared.map((c) => c.id).sort());
  assert.ok(declared.every((c) => c.context === 'global'));
  assert.deepEqual(Object.keys(s.events), manifest.contributes.events.map((e) => e.on));
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

test('complete runs the CLI for the linked item and deletes the link on success', async () => {
  const s = setup({ context: ACTIVE, storage: { 'link:wt1': LINK }, replies: [envelope({})] });
  activate(s.orca, s.deps);
  await s.handlers.complete();
  assert.deepEqual(s.calls[0].args, ['todos', 'complete', '5', '--in', '7', '--json']);
  assert.equal(s.store.has('link:wt1'), false);
  assert.match(notes(s).at(-1).body, /Completed: Fix login/);
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
