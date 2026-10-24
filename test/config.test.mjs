import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { childEnv, configFilePath, loadConfig } from '../src/config.mjs';

const memFs = (files = {}) => ({ readFile: async (p) => (p in files ? files[p] : null) });

test('configFilePath on Windows rebuilds APPDATA from USERPROFILE', () => {
  const file = configFilePath({ env: { USERPROFILE: 'C:\\Users\\me' }, platform: 'win32', pathApi: path.win32 });
  assert.equal(file, 'C:\\Users\\me\\AppData\\Roaming\\orca-basecamp\\config.json');
});

test('configFilePath on Windows keeps APPDATA when present', () => {
  const file = configFilePath({ env: { APPDATA: 'D:\\Roam', USERPROFILE: 'C:\\u' }, platform: 'win32', pathApi: path.win32 });
  assert.equal(file, 'D:\\Roam\\orca-basecamp\\config.json');
});

test('configFilePath elsewhere uses XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(
    configFilePath({ env: { XDG_CONFIG_HOME: '/x' }, platform: 'linux', pathApi: path.posix }),
    '/x/orca-basecamp/config.json'
  );
  assert.equal(
    configFilePath({ env: { HOME: '/home/me' }, platform: 'linux', pathApi: path.posix }),
    '/home/me/.config/orca-basecamp/config.json'
  );
});

test('loadConfig returns an empty config when the file does not exist', async () => {
  assert.deepEqual(await loadConfig({ configFile: '/c.json', fs: memFs() }), { basecampEnv: {} });
});

test('loadConfig reads basecampBin and the allowed basecampEnv keys', async () => {
  const text = JSON.stringify({
    basecampBin: 'C:\\Users\\me\\bin\\basecamp.exe',
    basecampEnv: { BASECAMP_NO_KEYRING: '1', BASECAMP_PROFILE: 'work', BASECAMP_ACCOUNT_ID: '99' }
  });
  assert.deepEqual(await loadConfig({ configFile: '/c.json', fs: memFs({ '/c.json': text }) }), {
    basecampBin: 'C:\\Users\\me\\bin\\basecamp.exe',
    basecampEnv: { BASECAMP_NO_KEYRING: '1', BASECAMP_PROFILE: 'work', BASECAMP_ACCOUNT_ID: '99' }
  });
});

test('loadConfig refuses env keys outside the allowlist, naming the key but never the value', async () => {
  const text = JSON.stringify({ basecampEnv: { BASECAMP_TOKEN: 'sekret-value' } });
  await assert.rejects(
    loadConfig({ configFile: '/c.json', fs: memFs({ '/c.json': text }) }),
    (e) => e.message.includes('BASECAMP_TOKEN') && !e.message.includes('sekret-value')
  );
});

test('loadConfig rejects invalid JSON, a non-string bin and non-string env values', async () => {
  await assert.rejects(loadConfig({ configFile: '/c.json', fs: memFs({ '/c.json': '{nope' }) }), /Invalid JSON in \/c\.json/);
  await assert.rejects(
    loadConfig({ configFile: '/c.json', fs: memFs({ '/c.json': '{"basecampBin": 5}' }) }),
    /basecampBin/
  );
  await assert.rejects(
    loadConfig({ configFile: '/c.json', fs: memFs({ '/c.json': '{"basecampEnv":{"BASECAMP_PROFILE":1}}' }) }),
    /BASECAMP_PROFILE/
  );
});

test('childEnv adds HOME from USERPROFILE, non-interactive and no-color flags', () => {
  const env = childEnv({ env: { USERPROFILE: 'C:\\Users\\me', PATH: 'p' } });
  assert.equal(env.HOME, 'C:\\Users\\me');
  assert.equal(env.BASECAMP_NONINTERACTIVE, '1');
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.PATH, 'p');
});

test('childEnv keeps an existing HOME', () => {
  assert.equal(childEnv({ env: { HOME: '/h', USERPROFILE: '/u' } }).HOME, '/h');
});

test('childEnv never carries BASECAMP_TOKEN, even if the worker env has it', () => {
  const env = childEnv({ env: { BASECAMP_TOKEN: 'abc', PATH: 'p' }, basecampEnv: { BASECAMP_PROFILE: 'w' } });
  assert.equal('BASECAMP_TOKEN' in env, false);
  assert.equal(env.BASECAMP_PROFILE, 'w');
});
