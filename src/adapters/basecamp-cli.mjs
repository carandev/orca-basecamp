import { childEnv, cliNotFoundMessage, DEFAULT_BIN } from '../config.mjs';
import { htmlToText } from '../domain/html-text.mjs';

const READ_TIMEOUT_MS = 20_000;
const COMPLETE_TIMEOUT_MS = 10_000;
const NUMERIC = /^\d+$/;
const INACCESSIBLE = /not.?found|404|forbidden|permission|403/i;
const ALREADY = /already/i;

/** Typed failure of the work-item source. `retryable` is informational: nothing retries automatically. */
export class SourceError extends Error {
  constructor({ code, message, hint = '', retryable = false }) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
  }
}

const fail = (code, message, extra = {}) => new SourceError({ code, message, ...extra });

/** Ids reach the argv only after this check, so they can never be read as flags or extra arguments. */
function numericId(value, name) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !NUMERIC.test(text)) throw fail('invalid_argument', `${name} must be a numeric id`);
  return text;
}

function itemType(type) {
  if (type !== 'todo' && type !== 'card') throw fail('invalid_argument', `Unknown item type "${type}"`);
  return type;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parseEnvelope(...texts) {
  for (const text of texts) {
    if (typeof text !== 'string' || !text.trim()) continue;
    try {
      const value = JSON.parse(text);
      if (isObject(value) && typeof value.ok === 'boolean') return value;
    } catch {
      // try the next stream
    }
  }
  return null;
}

function normalize(raw, type, bucket, fallbackProjectId) {
  if (!isObject(raw) || typeof raw.title !== 'string' || typeof raw.app_url !== 'string' || raw.id == null) {
    throw fail('bad_output', 'The basecamp CLI returned an item without id, title or app_url');
  }
  const b = bucket ?? raw.bucket;
  const projectId = b?.id ?? (fallbackProjectId !== undefined ? Number(fallbackProjectId) : undefined);
  return {
    type,
    id: raw.id,
    projectId,
    projectName: typeof b?.name === 'string' ? b.name : '',
    title: raw.title,
    description: htmlToText(raw.description),
    appUrl: raw.app_url
  };
}

/**
 * TodoSource backed by the `basecamp` CLI, always with `--json`. One spawn per operation, argv arrays only,
 * no retries. `list` resolves to `{items, notice?}` so the CLI's cap notice can reach the UI.
 */
export function createBasecampSource({ spawner, config, env, configFile }) {
  const bin = config.basecampBin ?? DEFAULT_BIN;
  const spawnEnv = childEnv({ env, basecampEnv: config.basecampEnv });

  async function call(args, timeoutMs) {
    const result = await spawner.run(bin, [...args, '--json'], { env: spawnEnv, timeoutMs });
    if (result.spawnError?.code === 'ENOENT') {
      throw fail('cli_not_found', cliNotFoundMessage(bin, configFile));
    }
    if (result.spawnError) throw fail('spawn_failed', `Could not run "${bin}": ${result.spawnError.code}`);
    if (result.timedOut) throw fail('timeout', `"${bin} ${args[0]}" timed out after ${timeoutMs / 1000} s`);
    const envelope = parseEnvelope(result.stdout, result.stderr);
    if (envelope === null) throw fail('bad_output', `"${bin} ${args[0]}" returned no JSON envelope (exit code ${result.code})`);
    return envelope;
  }

  /** Runs a call and returns the envelope, throwing a SourceError when `ok` is false. */
  async function read(args, timeoutMs = READ_TIMEOUT_MS) {
    const envelope = await call(args, timeoutMs);
    if (!envelope.ok) throw errorFrom(envelope);
    return envelope;
  }

  const errorFrom = (e) =>
    fail(String(e.code ?? 'cli_error'), String(e.error ?? 'The basecamp CLI reported an error'), {
      hint: typeof e.hint === 'string' ? e.hint : '',
      retryable: e.retryable === true
    });

  return {
    async list(query) {
      if (query?.kind === 'todo') {
        const envelope = await read(['todos', 'list', '--all-projects']);
        if (!Array.isArray(envelope.data)) throw fail('bad_output', 'Expected a list of bucket groups');
        const items = [];
        for (const group of envelope.data) {
          if (!isObject(group) || !Array.isArray(group.todos)) throw fail('bad_output', 'Expected a bucket group with todos');
          for (const raw of group.todos) items.push(normalize(raw, 'todo', group.bucket));
        }
        return withNotice(items, envelope);
      }
      if (query?.kind === 'card') {
        const projectId = numericId(query.projectId, 'projectId');
        const envelope = await read(['cards', 'list', '--in', projectId]);
        if (!Array.isArray(envelope.data)) throw fail('bad_output', 'Expected a list of cards');
        return withNotice(envelope.data.map((raw) => normalize(raw, 'card', undefined, projectId)), envelope);
      }
      throw fail('invalid_argument', `Unknown list kind "${query?.kind}"`);
    },

    async projects() {
      const envelope = await read(['projects', 'list']);
      if (!Array.isArray(envelope.data)) throw fail('bad_output', 'Expected a list of projects');
      return envelope.data.map((p) => ({ id: p.id, name: p.name }));
    },

    async get({ type, id, projectId }) {
      const kind = itemType(type);
      const args = [kind === 'todo' ? 'todos' : 'cards', 'show', numericId(id, 'id'), '--in', numericId(projectId, 'projectId')];
      const envelope = await read(args);
      if (!isObject(envelope.data)) throw fail('bad_output', 'Expected a single item');
      return normalize(envelope.data, kind, undefined, projectId);
    },

    async complete({ type, id, projectId }) {
      const kind = itemType(type);
      const verb = kind === 'todo' ? ['todos', 'complete'] : ['cards', 'done'];
      const envelope = await call([...verb, numericId(id, 'id'), '--in', numericId(projectId, 'projectId')], COMPLETE_TIMEOUT_MS);
      if (envelope.ok) return { status: 'completed' };
      const text = `${envelope.code ?? ''} ${envelope.error ?? ''}`;
      if (ALREADY.test(text)) return { status: 'already' };
      if (INACCESSIBLE.test(text)) return { status: 'inaccessible' };
      throw errorFrom(envelope);
    }
  };
}

function withNotice(items, envelope) {
  return typeof envelope.notice === 'string' && envelope.notice ? { items, notice: envelope.notice } : { items };
}
