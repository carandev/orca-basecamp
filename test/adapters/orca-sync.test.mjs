import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrcaAdapter } from '../../src/adapters/orca.mjs';

/** Records [args, options] per call and answers with the scripted result (or rejects with an Error). */
function fakeCli(result) {
  const calls = [];
  const orcaCli = async (args, options) => {
    calls.push({ args, options });
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, orcaCli };
}

const adapter = (cli) => createOrcaAdapter({ orcaCli: cli.orcaCli, readContext: async () => null });

// ---- listWorktreeStatuses --------------------------------------------------

test('listWorktreeStatuses asks for 1000 rows with a 20 s timeout and maps id -> workspaceStatus', async () => {
  const cli = fakeCli({
    worktrees: [
      { id: 'r::/a', workspaceStatus: 'in-review' },
      { id: 'r::/b', workspaceStatus: 'my-custom' }
    ],
    totalCount: 2,
    truncated: false
  });
  const out = await adapter(cli).listWorktreeStatuses();
  assert.deepEqual(cli.calls, [{ args: ['worktree', 'list', '--limit', '1000'], options: { timeoutMs: 20_000 } }]);
  assert.deepEqual([...out.statuses], [['r::/a', 'in-review'], ['r::/b', 'my-custom']]);
  assert.equal(out.truncated, false);
});

test('listWorktreeStatuses omits rows without a string workspaceStatus', async () => {
  const cli = fakeCli({
    worktrees: [{ id: 'a', workspaceStatus: 'todo' }, { id: 'b' }, { id: 'c', workspaceStatus: 5 }, { workspaceStatus: 'x' }],
    totalCount: 4
  });
  const out = await adapter(cli).listWorktreeStatuses();
  assert.deepEqual([...out.statuses], [['a', 'todo']]);
});

test('truncated is true when the CLI says so or when totalCount exceeds the rows', async () => {
  const flagged = await adapter(fakeCli({ worktrees: [{ id: 'a', workspaceStatus: 's' }], totalCount: 1, truncated: true })).listWorktreeStatuses();
  assert.equal(flagged.truncated, true);
  const counted = await adapter(fakeCli({ worktrees: [{ id: 'a', workspaceStatus: 's' }], totalCount: 5 })).listWorktreeStatuses();
  assert.equal(counted.truncated, true);
  const exact = await adapter(fakeCli({ worktrees: [{ id: 'a', workspaceStatus: 's' }], totalCount: 1 })).listWorktreeStatuses();
  assert.equal(exact.truncated, false);
});

test('listWorktreeStatuses tolerates an empty or missing result', async () => {
  const out = await adapter(fakeCli(undefined)).listWorktreeStatuses();
  assert.equal(out.statuses.size, 0);
  assert.equal(out.truncated, false);
});

test('listWorktreeStatuses propagates CLI failures', async () => {
  await assert.rejects(adapter(fakeCli(new Error('orca down'))).listWorktreeStatuses(), /orca down/);
});

// ---- setStatus -------------------------------------------------------------

test('setStatus runs worktree set with the exact argv and a 10 s timeout', async () => {
  const cli = fakeCli({});
  await adapter(cli).setStatus('r::/w', 'in-review');
  assert.deepEqual(cli.calls, [
    { args: ['worktree', 'set', '--worktree', 'id:r::/w', '--workspace-status', 'in-review'], options: { timeoutMs: 10_000 } }
  ]);
});

test('setStatus accepts a per-call timeout override', async () => {
  const cli = fakeCli({});
  await adapter(cli).setStatus('r::/w', 'completed', { timeoutMs: 4_000 });
  assert.equal(cli.calls[0].options.timeoutMs, 4_000);
});

test('setStatus throws before any spawn on an invalid status or worktree id', async () => {
  const bad = [
    ['r::/w', '--read'],
    ['r::/w', '-x'],
    ['r::/w', 'a b'],
    ['r::/w', 'a'.repeat(41)],
    ['r::/w', ''],
    ['r::/w', 5],
    ['r::/w\nx', 'todo'],
    ['', 'todo'],
    [undefined, 'todo']
  ];
  for (const [id, status] of bad) {
    const cli = fakeCli({});
    await assert.rejects(adapter(cli).setStatus(id, status), /invalid/i, `${id} ${status}`);
    assert.equal(cli.calls.length, 0, `${id} ${status}`);
  }
});

test('setStatus propagates CLI failures', async () => {
  await assert.rejects(adapter(fakeCli(new Error('orca down'))).setStatus('r::/w', 'todo'), /orca down/);
});
