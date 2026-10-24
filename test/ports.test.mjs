import test from 'node:test';
import assert from 'node:assert/strict';
import { spawner } from '../ports.mjs';

const node = process.execPath;
const run = (args, timeoutMs = 10_000) => spawner.run(node, args, { env: process.env, timeoutMs });

test('spawner.run captures stdout and a zero exit code', async () => {
  const r = await run(['-e', "console.log('hi')"]);
  assert.equal(r.stdout.trim(), 'hi');
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
  assert.equal(r.spawnError, undefined);
});

test('spawner.run reports a non-zero exit code and stderr without throwing', async () => {
  const r = await run(['-e', "console.error('bad'); process.exit(3)"]);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /bad/);
  assert.equal(r.timedOut, false);
});

test('spawner.run passes shell metacharacters as one literal argv entry (no shell)', async () => {
  const r = await run(['-e', 'console.log(process.argv[1])', 'a & b $HOME']);
  assert.equal(r.stdout.trim(), 'a & b $HOME');
});

test('spawner.run maps a missing binary to spawnError ENOENT', async () => {
  const r = await spawner.run('definitely-not-a-real-binary-xyz', [], { env: process.env, timeoutMs: 5000 });
  assert.equal(r.spawnError.code, 'ENOENT');
});

test('spawner.run flags a timeout', async () => {
  const r = await run(['-e', 'setTimeout(() => {}, 10000)'], 200);
  assert.equal(r.timedOut, true);
});

test('spawner.run uses the env it is given', async () => {
  const r = await spawner.run(node, ['-e', 'console.log(process.env.PROBE)'], {
    env: { ...process.env, PROBE: 'yes' },
    timeoutMs: 5000
  });
  assert.equal(r.stdout.trim(), 'yes');
});
