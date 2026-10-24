import nodePath from 'node:path';

/** The only env vars a user may add to the basecamp child process. BASECAMP_TOKEN is deliberately absent. */
export const ALLOWED_ENV_KEYS = ['BASECAMP_NO_KEYRING', 'BASECAMP_PROFILE', 'BASECAMP_ACCOUNT_ID'];

export const DEFAULT_BIN = 'basecamp';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * User config location: <APPDATA>\orca-basecamp\config.json on Windows
 * (APPDATA is rebuilt from USERPROFILE because the plugin worker env is scrubbed),
 * else $XDG_CONFIG_HOME or ~/.config.
 */
export function configFilePath({ env = process.env, platform = process.platform, pathApi = nodePath } = {}) {
  const home = env.USERPROFILE ?? env.HOME ?? '';
  if (platform === 'win32') {
    const appData = env.APPDATA ?? pathApi.join(home, 'AppData', 'Roaming');
    return pathApi.join(appData, 'orca-basecamp', 'config.json');
  }
  const base = env.XDG_CONFIG_HOME ?? pathApi.join(home, '.config');
  return pathApi.join(base, 'orca-basecamp', 'config.json');
}

/**
 * Reads `{basecampBin?, basecampEnv?}`. `fs.readFile(path)` returns the text or null when missing.
 * Env keys outside ALLOWED_ENV_KEYS are refused; error messages name keys, never values.
 * @returns {Promise<{basecampBin?: string, basecampEnv: Record<string, string>}>}
 */
export async function loadConfig({ configFile, fs }) {
  const text = await fs.readFile(configFile);
  if (text == null) return { basecampEnv: {} };
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid JSON in ${configFile}: ${e.message}`);
  }
  if (!isObject(data)) throw new Error(`${configFile} must contain a JSON object`);
  const config = { basecampEnv: {} };
  if (data.basecampBin !== undefined) {
    if (typeof data.basecampBin !== 'string' || !data.basecampBin.trim()) {
      throw new Error(`"basecampBin" in ${configFile} must be a non-empty string`);
    }
    config.basecampBin = data.basecampBin.trim();
  }
  if (data.basecampEnv !== undefined) {
    if (!isObject(data.basecampEnv)) throw new Error(`"basecampEnv" in ${configFile} must be an object`);
    for (const [key, value] of Object.entries(data.basecampEnv)) {
      if (!ALLOWED_ENV_KEYS.includes(key)) {
        throw new Error(`"basecampEnv.${key}" in ${configFile} is not allowed (allowed: ${ALLOWED_ENV_KEYS.join(', ')})`);
      }
      if (typeof value !== 'string') throw new Error(`"basecampEnv.${key}" in ${configFile} must be a string`);
      config.basecampEnv[key] = value;
    }
  }
  return config;
}

/**
 * Environment for the basecamp child process: the worker env, HOME from USERPROFILE when unset,
 * non-interactive and no-color flags, then the allowlisted user extras. BASECAMP_TOKEN is never forwarded.
 */
export function childEnv({ env = process.env, basecampEnv = {} } = {}) {
  const out = { ...env };
  delete out.BASECAMP_TOKEN;
  if (out.HOME === undefined && out.USERPROFILE !== undefined) out.HOME = out.USERPROFILE;
  out.BASECAMP_NONINTERACTIVE = '1';
  out.NO_COLOR = '1';
  for (const key of ALLOWED_ENV_KEYS) {
    if (basecampEnv[key] !== undefined) out[key] = basecampEnv[key];
  }
  return out;
}

/** Message for a binary that cannot be spawned. Names the resolved binary and the config file. */
export function cliNotFoundMessage(bin, configFile) {
  return (
    `Cannot run "${bin}". Install the basecamp CLI, add its folder to the PATH Orca gives plugins, ` +
    `or set "basecampBin" in ${configFile}.`
  );
}
