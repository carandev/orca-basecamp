import { childEnv, cliNotFoundMessage, DEFAULT_BIN } from '../config.mjs';
import { htmlToText } from '../domain/html-text.mjs';

const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 10_000;
const NUMERIC = /^\d+$/;
const INACCESSIBLE = /not.?found|404|forbidden|permission|403/i;
const ALREADY = /already/i;
const MAPPABLE_COLUMN = 'Kanban::Column';
const DONE_COLUMN = 'Kanban::DoneColumn';

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

const errorFrom = (e) =>
  fail(String(e.code ?? 'cli_error'), String(e.error ?? 'The basecamp CLI reported an error'), {
    hint: typeof e.hint === 'string' ? e.hint : '',
    retryable: e.retryable === true
  });

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

/** To-do: 'open' | 'completed'. Card: 'completed' or the NUMERIC id of its column (never the name). */
function stateOf(raw, type) {
  if (type === 'todo') return raw.completed === true ? 'completed' : 'open';
  if (raw.completed === true || raw.parent?.type === DONE_COLUMN) return 'completed';
  return raw.parent?.id == null ? undefined : String(raw.parent.id);
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
    appUrl: raw.app_url,
    state: stateOf(raw, type)
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

  async function getItem({ type, id, projectId }) {
    const kind = itemType(type);
    const args = [kind === 'todo' ? 'todos' : 'cards', 'show', numericId(id, 'id'), '--in', numericId(projectId, 'projectId')];
    const envelope = await read(args);
    if (!isObject(envelope.data)) throw fail('bad_output', 'Expected a single item');
    return normalize(envelope.data, kind, undefined, projectId);
  }

  return {
    async list(query) {
      const mine = query?.mine === true;
      if (query?.kind === 'todo') {
        const envelope = await read(['todos', 'list', '--all-projects', ...(mine ? ['--assignee', 'me'] : [])]);
        return withNotice(flattenGroups(envelope, 'todos', 'todo'), envelope);
      }
      if (query?.kind === 'card') {
        if (mine) {
          // `--assignee` only works account-wide (it cannot be combined with `--in`), so no projectId is involved.
          const envelope = await read(['cards', 'list', '--assignee', 'me']);
          return withNotice(flattenGroups(envelope, 'cards', 'card'), envelope);
        }
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

    get: getItem,

    /** Sync state of an item: see `stateOf`. */
    async state({ type, id, projectId }) {
      const { state } = await getItem({ type, id, projectId });
      if (state === undefined) throw fail('bad_output', 'The basecamp CLI returned a card without a column');
      return state;
    },

    async complete({ type, id, projectId }) {
      const kind = itemType(type);
      const verb = kind === 'todo' ? ['todos', 'complete'] : ['cards', 'done'];
      return outcome(await call([...verb, numericId(id, 'id'), '--in', numericId(projectId, 'projectId')], WRITE_TIMEOUT_MS), 'completed');
    },

    /** Reopens a to-do (`todos uncomplete`). */
    async reopen({ id, projectId }) {
      const args = ['todos', 'uncomplete', numericId(id, 'id'), '--in', numericId(projectId, 'projectId')];
      return outcome(await call(args, WRITE_TIMEOUT_MS), 'reopened');
    },

    /** Card columns of the project's card table; only plain columns are valid mapping targets. */
    async columns({ projectId }) {
      const envelope = await read(['cards', 'columns', '--in', numericId(projectId, 'projectId')]);
      if (!Array.isArray(envelope.data)) throw fail('bad_output', 'Expected a list of columns');
      return envelope.data.map((c) => ({
        id: String(c.id),
        name: String(c.title ?? c.name),
        type: c.type,
        mappable: c.type === MAPPABLE_COLUMN
      }));
    },

    /** Moves a card to a column by numeric id (a name would need `--card-table`). */
    async move({ id, projectId, columnId }) {
      const args = ['cards', 'move', numericId(id, 'id'), '--to', numericId(columnId, 'columnId'), '--in', numericId(projectId, 'projectId')];
      return outcome(await call(args, WRITE_TIMEOUT_MS), 'moved');
    }
  };
}

/** Maps a write envelope to `{status}`: ok, `already`, `inaccessible`, or a thrown SourceError. */
function outcome(envelope, okStatus) {
  if (envelope.ok) return { status: okStatus };
  const text = `${envelope.code ?? ''} ${envelope.error ?? ''}`;
  if (ALREADY.test(text)) return { status: 'already' };
  if (INACCESSIBLE.test(text)) return { status: 'inaccessible' };
  throw errorFrom(envelope);
}

/** Flattens `{data:[{bucket, <field>:[...]}]}` into normalized items, each taking its projectId from its group. */
function flattenGroups(envelope, field, type) {
  if (!Array.isArray(envelope.data)) throw fail('bad_output', 'Expected a list of bucket groups');
  const items = [];
  for (const group of envelope.data) {
    if (!isObject(group) || !Array.isArray(group[field])) throw fail('bad_output', `Expected a bucket group with ${field}`);
    for (const raw of group[field]) items.push(normalize(raw, type, group.bucket));
  }
  return items;
}

function withNotice(items, envelope) {
  return typeof envelope.notice === 'string' && envelope.notice ? { items, notice: envelope.notice } : { items };
}
