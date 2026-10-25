import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveOrcaCli, createOrcaCli } from '../orca-cli.mjs';

const none = () => false;

test('resolveOrcaCli on Windows uses orca.exe and rebuilds APPDATA/LOCALAPPDATA from USERPROFILE', () => {
  const { bin, env } = resolveOrcaCli({
    env: { USERPROFILE: 'C:\\Users\\me', PATH: 'p' },
    platform: 'win32',
    pathApi: path.win32,
    exists: none,
  });
  assert.equal(bin, 'C:\\Users\\me\\AppData\\Local\\Programs\\orca\\resources\\bin\\orca.exe');
  assert.equal(env.APPDATA, 'C:\\Users\\me\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\Users\\me\\AppData\\Local');
  assert.equal(env.PATH, 'p');
});

test('resolveOrcaCli on Windows keeps APPDATA/LOCALAPPDATA when present', () => {
  const { bin, env } = resolveOrcaCli({
    env: { USERPROFILE: 'C:\\Users\\me', APPDATA: 'D:\\Roam', LOCALAPPDATA: 'D:\\Local' },
    platform: 'win32',
    pathApi: path.win32,
    exists: none,
  });
  assert.equal(bin, 'D:\\Local\\Programs\\orca\\resources\\bin\\orca.exe');
  assert.equal(env.APPDATA, 'D:\\Roam');
});

test('resolveOrcaCli on Linux prefers the ~/.local/bin/orca-ide symlink', () => {
  const link = '/home/me/.local/bin/orca-ide';
  const { bin, env } = resolveOrcaCli({
    env: { HOME: '/home/me', PATH: '/usr/bin' },
    platform: 'linux',
    pathApi: path.posix,
    exists: (p) => p === link,
  });
  assert.equal(bin, link);
  assert.deepEqual(env, { HOME: '/home/me', PATH: '/usr/bin' });
});

test('resolveOrcaCli on Linux falls back to orca-ide on PATH, never bare orca', () => {
  const { bin } = resolveOrcaCli({ env: { HOME: '/home/me' }, platform: 'linux', pathApi: path.posix, exists: none });
  assert.equal(bin, 'orca-ide');
});

test('resolveOrcaCli on macOS uses orca on PATH', () => {
  const { bin } = resolveOrcaCli({ env: { HOME: '/Users/me' }, platform: 'darwin', pathApi: path.posix, exists: none });
  assert.equal(bin, 'orca');
});

// ---- createOrcaCli: per-call timeout ---------------------------------------

/** Fake execFile: records [file, args, options] and answers with a JSON reply. */
function fakeExec(stdout = JSON.stringify({ ok: true, result: { done: true } })) {
  const calls = [];
  const exec = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(null, stdout, '');
  };
  return { calls, exec };
}

test('orcaCli keeps the 30 s default timeout and appends --json', async () => {
  const fake = fakeExec();
  const run = createOrcaCli({ execFile: fake.exec, bin: 'orca', env: { A: '1' } });
  assert.deepEqual(await run(['worktree', 'create']), { done: true });
  assert.deepEqual(fake.calls[0].args, ['worktree', 'create', '--json']);
  assert.equal(fake.calls[0].options.timeout, 30_000);
  assert.equal(fake.calls[0].file, 'orca');
});

test('orcaCli passes a per-call timeoutMs to the process', async () => {
  const fake = fakeExec();
  const run = createOrcaCli({ execFile: fake.exec, bin: 'orca', env: {} });
  await run(['worktree', 'set'], { timeoutMs: 10_000 });
  await run(['worktree', 'list'], { timeoutMs: 20_000 });
  assert.deepEqual(fake.calls.map((c) => c.options.timeout), [10_000, 20_000]);
});

test('orcaCli rejects on a non-ok reply', async () => {
  const fake = fakeExec(JSON.stringify({ ok: false, error: { message: 'nope' } }));
  const run = createOrcaCli({ execFile: fake.exec, bin: 'orca', env: {} });
  await assert.rejects(run(['x']), /orca x failed.*nope/);
});
