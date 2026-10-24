import { childEnv, cliNotFoundMessage, DEFAULT_BIN } from '../config.mjs';

const DIAGNOSE_TIMEOUT_MS = 10_000;
const AUTH_FIELDS = ['authenticated', 'source', 'oauth_type', 'storage'];
const MAX_VALUE = 200;

const yesNo = (v) => (v ? 'yes' : 'no');
const clip = (v) => String(v).slice(0, MAX_VALUE);

function parseEnvelope(stdout) {
  try {
    const value = JSON.parse(stdout);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** One `key: value` line per whitelisted field present in `source`. */
const pick = (source, keys) =>
  keys.filter((k) => source[k] !== undefined && typeof source[k] !== 'object').map((k) => `${k}: ${clip(source[k])}`);

/**
 * Diagnose spike: runs `--version` and `auth status --json` and builds a WHITELISTED summary.
 * Only fixed fields are printed, and env NAMES only as presence flags and a count: never values, never tokens.
 * @returns {Promise<{ok: boolean, cliNotFound: boolean, text: string}>}
 */
export async function diagnose({ spawner, config, env, configFile }) {
  const bin = config.basecampBin ?? DEFAULT_BIN;
  const opts = { env: childEnv({ env, basecampEnv: config.basecampEnv }), timeoutMs: DIAGNOSE_TIMEOUT_MS };
  const lines = [`binary: ${bin}`, `config file: ${configFile}`];
  const finish = (ok, cliNotFound = false) => {
    lines.push(
      `PATH present: ${yesNo(env.PATH !== undefined)}`,
      `USERPROFILE present: ${yesNo(env.USERPROFILE !== undefined)}`,
      `env vars: ${Object.keys(env).length}`
    );
    return { ok, cliNotFound, text: lines.join('\n') };
  };

  const version = await spawner.run(bin, ['--version'], opts);
  if (version.spawnError?.code === 'ENOENT') {
    lines.unshift('cli_not_found');
    lines.push(cliNotFoundMessage(bin, configFile));
    return finish(false, true);
  }
  if (version.spawnError) {
    lines.push(`spawn error: ${clip(version.spawnError.code)}`);
    return finish(false);
  }
  lines.push(`version: ${clip(version.stdout.trim().split('\n')[0] ?? '')}`, `version exit code: ${version.code}`);
  if (version.timedOut) {
    lines.push('timedOut: yes');
    return finish(false);
  }

  const auth = await spawner.run(bin, ['auth', 'status', '--json'], opts);
  lines.push(`exit code: ${auth.code}`, `timedOut: ${yesNo(auth.timedOut)}`);
  if (auth.spawnError) {
    lines.push(`spawn error: ${clip(auth.spawnError.code)}`);
    return finish(false);
  }
  const envelope = parseEnvelope(auth.stdout) ?? parseEnvelope(auth.stderr);
  if (envelope === null) {
    if (!auth.timedOut) lines.push('auth output: not valid JSON');
    return finish(false);
  }
  lines.push(`ok: ${envelope.ok === true}`);
  if (envelope.ok === true) {
    const data = envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : {};
    lines.push(...pick(data, AUTH_FIELDS));
    return finish(true);
  }
  lines.push(...pick({ 'error.code': envelope.code, hint: envelope.hint }, ['error.code', 'hint']));
  return finish(false);
}
