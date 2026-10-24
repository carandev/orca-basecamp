import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrcaAdapter } from '../../src/adapters/orca.mjs';
import { createStorage } from '../../src/adapters/storage.mjs';

/** Scripted orcaCli: maps `args.join(' ')` to a result (or an Error to reject with) and records every call. */
function fakeCli(table = {}) {
  const calls = [];
  const orcaCli = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    const hit = Object.entries(table).find(([prefix]) => key.startsWith(prefix));
    if (!hit) throw new Error(`unscripted orca call: ${key}`);
    if (hit[1] instanceof Error) throw hit[1];
    return hit[1];
  };
  return { calls, orcaCli };
}

const adapter = (cli, readContext = async () => null) => createOrcaAdapter({ orcaCli: cli.orcaCli, readContext });

// ---- orca adapter ----------------------------------------------------------

test('listRepos maps id, displayName and path', async () => {
  const cli = fakeCli({
    'repo list': { repos: [{ id: 'r1', displayName: 'Alpha', path: '/a', kind: 'git' }, { id: 'r2', displayName: 'Beta', path: '/b' }] }
  });
  assert.deepEqual(await adapter(cli).listRepos(), [
    { id: 'r1', name: 'Alpha', path: '/a' },
    { id: 'r2', name: 'Beta', path: '/b' }
  ]);
  assert.deepEqual(cli.calls, [['repo', 'list']]);
});

test('createWorktree passes repo, name and comment as separate argv entries', async () => {
  const cli = fakeCli({ 'worktree create': { worktree: { id: 'wt-1', path: '/w/bc-1' } } });
  const out = await adapter(cli).createWorktree({ repoId: 'r1', name: 'bc-1-x', comment: 'T https://app.basecamp.com/1' });
  assert.deepEqual(cli.calls[0], [
    'worktree', 'create', '--repo', 'id:r1', '--name', 'bc-1-x', '--comment', 'T https://app.basecamp.com/1'
  ]);
  assert.deepEqual(out, { worktreeId: 'wt-1', path: '/w/bc-1' });
});

test('createWorktree adds --agent and --prompt only when an agent is chosen; the prompt stays one value', async () => {
  const cli = fakeCli({ 'worktree create': { id: 'wt-2', path: '/w/2' } });
  const prompt = 'Say "hi" & bye\n\nline2 $(x)';
  const out = await adapter(cli).createWorktree({ repoId: 'r1', name: 'bc-2', comment: 'c', agent: 'claude', prompt });
  assert.deepEqual(cli.calls[0], [
    'worktree', 'create', '--repo', 'id:r1', '--name', 'bc-2', '--comment', 'c', '--agent', 'claude', '--prompt', prompt
  ]);
  assert.deepEqual(out, { worktreeId: 'wt-2', path: '/w/2' });
});

test('createWorktree tolerates a result without id or path', async () => {
  const cli = fakeCli({ 'worktree create': {} });
  assert.deepEqual(await adapter(cli).createWorktree({ repoId: 'r1', name: 'n', comment: 'c' }), {
    worktreeId: undefined,
    path: undefined
  });
});

test('createWorktree propagates a failure', async () => {
  const cli = fakeCli({ 'worktree create': new Error('orca down') });
  await assert.rejects(adapter(cli).createWorktree({ repoId: 'r1', name: 'n', comment: 'c' }), /orca down/);
});

test('findWorktree matches by path, then by display name, and refuses ambiguity', async () => {
  const worktrees = [
    { id: 'a', displayName: 'bc-1', path: '/w/bc-1' },
    { id: 'b', displayName: 'other', path: '/w/other' },
    { id: 'c', displayName: 'dup', path: '/w/dup1' },
    { id: 'd', displayName: 'dup', path: '/w/dup2' }
  ];
  const cli = fakeCli({ 'worktree list': { worktrees } });
  const o = adapter(cli);
  assert.equal(await o.findWorktree({ name: 'zzz', path: '/w/other' }), 'b');
  assert.equal(await o.findWorktree({ name: 'bc-1' }), 'a');
  assert.equal(await o.findWorktree({ name: 'dup' }), null);
  assert.equal(await o.findWorktree({ name: 'missing' }), null);
});

test('openTab runs tab create with the worktree selector and url', async () => {
  const cli = fakeCli({ 'tab create': {} });
  await adapter(cli).openTab({ worktreeId: 'wt-1', url: 'https://app.basecamp.com/1' });
  assert.deepEqual(cli.calls[0], ['tab', 'create', '--worktree', 'id:wt-1', '--url', 'https://app.basecamp.com/1']);
});

test('resolveActiveWorktree is null and spawns nothing when no worktree is focused', async () => {
  const cli = fakeCli();
  assert.equal(await adapter(cli, async () => null).resolveActiveWorktree(), null);
  assert.deepEqual(cli.calls, []);
});

test('resolveActiveWorktree uses the first terminal when there is one', async () => {
  const cli = fakeCli({ 'terminal show': { terminal: { worktreeId: 'wt-9', worktreePath: '/w/9' } } });
  const active = await adapter(cli, async () => ({ branch: 'b', displayName: 'd', terminals: [{ id: 't1' }, { id: 't2' }] })).resolveActiveWorktree();
  assert.deepEqual(active, { worktreeId: 'wt-9', worktreePath: '/w/9' });
  assert.deepEqual(cli.calls, [['terminal', 'show', '--terminal', 't1']]);
});

test('resolveActiveWorktree falls back to worktree list by display name and branch', async () => {
  const worktrees = [
    { id: 'x', displayName: 'bc-1', branch: 'refs/heads/bc-1', path: '/w/1' },
    { id: 'y', displayName: 'bc-2', branch: 'refs/heads/bc-2', path: '/w/2' }
  ];
  const cli = fakeCli({ 'worktree list': { worktrees } });
  const ctx = { branch: 'bc-2', displayName: 'bc-2', terminals: [] };
  assert.deepEqual(await adapter(cli, async () => ctx).resolveActiveWorktree(), { worktreeId: 'y', worktreePath: '/w/2' });
});

test('resolveActiveWorktree throws on no match, an ambiguous match or a missing id', async () => {
  const ctx = { branch: 'b', displayName: 'd', terminals: [] };
  const none = fakeCli({ 'worktree list': { worktrees: [] } });
  await assert.rejects(adapter(none, async () => ctx).resolveActiveWorktree(), /No worktree matches/);
  const two = fakeCli({ 'worktree list': { worktrees: [{ id: '1', displayName: 'd', branch: 'b', path: '/1' }, { id: '2', displayName: 'd', branch: 'b', path: '/2' }] } });
  await assert.rejects(adapter(two, async () => ctx).resolveActiveWorktree(), /Multiple worktrees/);
  const bare = fakeCli({ 'terminal show': { terminal: {} } });
  await assert.rejects(
    adapter(bare, async () => ({ ...ctx, terminals: [{ id: 't' }] })).resolveActiveWorktree(),
    /Could not resolve/
  );
});

// ---- storage adapter -------------------------------------------------------

function fakeHost(initial = {}) {
  const data = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    data,
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'storage.get') return { value: data.has(params.key) ? data.get(params.key) : null };
      if (method === 'storage.set') {
        data.set(params.key, params.value);
        return { ok: true };
      }
      if (method === 'storage.delete') {
        data.delete(params.key);
        return { ok: true };
      }
      if (method === 'storage.keys') return { keys: [...data.keys()] };
      throw new Error(`unexpected host call ${method}`);
    }
  };
}

test('storage get returns the stored value or null', async () => {
  const host = fakeHost({ a: { v: 1 } });
  const storage = createStorage(host.call);
  assert.deepEqual(await storage.get('a'), { v: 1 });
  assert.equal(await storage.get('missing'), null);
  assert.deepEqual(host.calls[0], ['storage.get', { key: 'a' }]);
});

test('storage set, delete and keys round-trip', async () => {
  const host = fakeHost();
  const storage = createStorage(host.call);
  await storage.set('k1', { n: 1 });
  await storage.set('k2', { n: 2 });
  assert.deepEqual(await storage.keys(), ['k1', 'k2']);
  await storage.delete('k1');
  assert.deepEqual(await storage.keys(), ['k2']);
  assert.equal(await storage.get('k1'), null);
  assert.deepEqual(host.calls[0], ['storage.set', { key: 'k1', value: { n: 1 } }]);
});
