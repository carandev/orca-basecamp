import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { browserCommand } from './src/open-url.mjs';

const MAX_BUFFER = 8 * 1024 * 1024;

/** Node implementation of the fs port (only what the plugin needs so far). */
export const fs = {
  readFile: async (file) => {
    try {
      return await readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }
};

/**
 * Spawner port: runs `file` with an argv array, never through a shell. It never rejects:
 * a failed spawn (e.g. ENOENT) is reported as `spawnError`, a timeout as `timedOut`.
 * @typedef {{stdout: string, stderr: string, code: number|null, timedOut: boolean, spawnError?: {code: string}}} SpawnResult
 */
export const spawner = {
  /** @returns {Promise<SpawnResult>} */
  run: (file, args, { env, timeoutMs }) =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        { env, windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const result = { stdout: stdout ?? '', stderr: stderr ?? '', code: 0, timedOut: false };
          if (error) {
            result.timedOut = error.killed === true && error.signal != null;
            if (typeof error.code === 'number') result.code = error.code;
            else {
              result.code = null;
              if (!result.timedOut) result.spawnError = { code: String(error.code ?? 'UNKNOWN') };
            }
          }
          resolve(result);
        }
      );
    })
};

/** Opens a url in the OS default browser. */
export const openExternal = (url) =>
  new Promise((resolve, reject) => {
    const [file, args] = browserCommand(url);
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error) => (error ? reject(error) : resolve()));
  });
