import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose } from '../src/usecases/diagnose.mjs';

const CONFIG_FILE = '/cfg/orca-basecamp/config.json';
const ok = (stdout, extra = {}) => ({ stdout, stderr: '', code: 0, timedOut: false, ...extra });

/** Scripted spawner: replies in order and records every call. */
function scripted(...replies) {
  const calls = [];
  return {
    calls,
    run: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return replies[calls.length - 1];
    }
  };
}

const AUTH_OK = JSON.stringify({
  ok: true,
  data: {
    authenticated: true,
    source: 'oauth',
    oauth_type: 'bc3',
    storage: 'keyring',
    access_token: 'LEAK-ACCESS',
    refresh_token: 'LEAK-REFRESH',
    user: { email: 'leak@example.com' }
  }
});

const run = (spawner, over = {}) =>
  diagnose({
    spawner,
    config: { basecampEnv: {} },
    env: { PATH: '/bin', USERPROFILE: '/u', SECRET_VAR: 'LEAK-ENV-VALUE' },
    configFile: CONFIG_FILE,
    ...over
  });

test('runs --version, then auth status --json, with the configured bin and a 10 s cap', async () => {
  const sp = scripted(ok('basecamp 1.2.3\n'), ok(AUTH_OK));
  await run(sp, { config: { basecampBin: '/opt/basecamp', basecampEnv: {} } });
  assert.deepEqual(
    sp.calls.map((c) => [c.file, c.args]),
    [
      ['/opt/basecamp', ['--version']],
      ['/opt/basecamp', ['auth', 'status', '--json']]
    ]
  );
  assert.deepEqual(sp.calls.map((c) => c.opts.timeoutMs), [10_000, 10_000]);
});

test('defaults the binary to "basecamp" on PATH', async () => {
  const sp = scripted(ok('v\n'), ok(AUTH_OK));
  await run(sp);
  assert.equal(sp.calls[0].file, 'basecamp');
});

test('child env adds HOME=USERPROFILE and the non-interactive flags, and never BASECAMP_TOKEN', async () => {
  const sp = scripted(ok('v\n'), ok(AUTH_OK));
  await run(sp, { env: { USERPROFILE: '/u', BASECAMP_TOKEN: 'LEAK-TOKEN', PATH: '/bin' } });
  assert.equal(sp.calls.length, 2);
  for (const { opts } of sp.calls) {
    assert.equal(opts.env.HOME, '/u');
    assert.equal(opts.env.BASECAMP_NONINTERACTIVE, '1');
    assert.equal(opts.env.NO_COLOR, '1');
    assert.equal('BASECAMP_TOKEN' in opts.env, false);
  }
});

test('ENOENT -> cli_not_found naming the binary and the config path, without calling auth', async () => {
  const sp = scripted({ stdout: '', stderr: '', code: null, timedOut: false, spawnError: { code: 'ENOENT' } });
  const r = await run(sp, { config: { basecampBin: 'C:\\x\\basecamp.exe', basecampEnv: {} } });
  assert.equal(sp.calls.length, 1);
  assert.equal(r.cliNotFound, true);
  assert.equal(r.ok, false);
  assert.ok(r.text.includes('cli_not_found'));
  assert.ok(r.text.includes('C:\\x\\basecamp.exe'));
  assert.ok(r.text.includes(CONFIG_FILE));
  assert.match(r.text, /basecampBin/);
});

test('summary whitelists auth fields and never prints tokens or user data', async () => {
  const r = await run(scripted(ok('basecamp 1.2.3\n'), ok(AUTH_OK)));
  assert.equal(r.ok, true);
  assert.match(r.text, /source: oauth/);
  assert.match(r.text, /oauth_type: bc3/);
  assert.match(r.text, /storage: keyring/);
  assert.match(r.text, /basecamp 1\.2\.3/);
  for (const leak of ['LEAK-ACCESS', 'LEAK-REFRESH', 'leak@example.com']) {
    assert.equal(r.text.includes(leak), false, `${leak} must not appear`);
  }
});

test('env section lists NAMES only: presence flags and a count, never values', async () => {
  const r = await run(scripted(ok('v\n'), ok(AUTH_OK)));
  assert.match(r.text, /PATH present: yes/);
  assert.match(r.text, /USERPROFILE present: yes/);
  assert.match(r.text, /env vars: 3/);
  assert.equal(r.text.includes('LEAK-ENV-VALUE'), false);
  assert.equal(r.text.includes('SECRET_VAR'), false);
  assert.ok(r.text.includes(CONFIG_FILE));
});

test('reports a missing PATH/USERPROFILE as "no"', async () => {
  const r = await run(scripted(ok('v\n'), ok(AUTH_OK)), { env: {} });
  assert.match(r.text, /PATH present: no/);
  assert.match(r.text, /USERPROFILE present: no/);
  assert.match(r.text, /env vars: 0/);
});

test('auth ok:false surfaces error code and hint, not the free-text error', async () => {
  const body = JSON.stringify({
    ok: false,
    error: 'free text LEAK-ERR',
    code: 'auth_required',
    hint: 'run basecamp auth login',
    retryable: false
  });
  const r = await run(scripted(ok('v\n'), ok(body, { code: 1 })));
  assert.equal(r.ok, false);
  assert.match(r.text, /error\.code: auth_required/);
  assert.match(r.text, /hint: run basecamp auth login/);
  assert.equal(r.text.includes('LEAK-ERR'), false);
});

test('a timeout and a non-JSON reply are reported without throwing', async () => {
  const timedOut = await run(scripted(ok('v\n'), { stdout: '', stderr: '', code: null, timedOut: true }));
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.text, /timedOut: yes/);
  const junk = await run(scripted(ok('v\n'), ok('not json LEAK-RAW', { code: 2 })));
  assert.equal(junk.ok, false);
  assert.match(junk.text, /exit code: 2/);
  assert.match(junk.text, /not valid JSON/);
  assert.equal(junk.text.includes('LEAK-RAW'), false);
});

test('a timeout on --version stops before auth', async () => {
  const sp = scripted({ stdout: '', stderr: '', code: null, timedOut: true });
  const r = await run(sp);
  assert.equal(sp.calls.length, 1);
  assert.equal(r.ok, false);
  assert.match(r.text, /timedOut: yes/);
});
