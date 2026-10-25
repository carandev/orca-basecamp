/** Sync settings: validation (strict, for POST) and normalization (lenient, for stored values). */

export const STATUS_PATTERN = /^[A-Za-z0-9][\w.-]{0,39}$/;
export const NUMERIC_ID = /^\d+$/;
export const CONFLICT_RULES = ['orca-wins', 'basecamp-wins'];
export const MAX_PROJECTS = 50;
export const MAX_STATUSES = 30;
/** `completed` is fixed (to-do complete / card Done), so it can never be a mapping key. */
const RESERVED_STATUS = 'completed';

export const DEFAULT_SYNC_CONFIG = Object.freeze({ enabled: true, conflictRule: 'orca-wins', statusToColumn: Object.freeze({}) });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const validStatus = (s) => STATUS_PATTERN.test(s) && s !== RESERVED_STATUS;

const defaults = () => ({ enabled: true, conflictRule: 'orca-wins', statusToColumn: {} });

/** Builds a clean `{status: columnId}` map; the first problem is returned as `error`. */
function cleanProject(statuses, lenient) {
  const out = {};
  for (const [status, column] of Object.entries(statuses)) {
    if (!validStatus(status) || typeof column !== 'string' || !NUMERIC_ID.test(column)) {
      if (lenient) continue;
      return { error: `Invalid mapping "${status}"` };
    }
    out[status] = column;
  }
  return { value: out };
}

function cleanMap(map, lenient) {
  const out = {};
  const entries = Object.entries(map);
  if (!lenient && entries.length > MAX_PROJECTS) return { error: `At most ${MAX_PROJECTS} projects are allowed` };
  for (const [projectId, statuses] of entries) {
    if (projectId === '__proto__' || !NUMERIC_ID.test(projectId) || !isObject(statuses)) {
      if (lenient) continue;
      return { error: `Invalid project "${projectId}"` };
    }
    if (!lenient && Object.keys(statuses).length > MAX_STATUSES) return { error: `At most ${MAX_STATUSES} statuses per project` };
    const project = cleanProject(statuses, lenient);
    if (project.error) return project;
    out[projectId] = project.value;
  }
  return { value: out };
}

/** Strict check of a POST body: `{ok:true, value}` or `{ok:false, error}`. Unknown keys are dropped. */
export function validateSyncConfig(body) {
  if (!isObject(body)) return { ok: false, error: 'The body must be an object' };
  if (typeof body.enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' };
  if (!CONFLICT_RULES.includes(body.conflictRule)) return { ok: false, error: 'conflictRule must be orca-wins or basecamp-wins' };
  if (!isObject(body.statusToColumn)) return { ok: false, error: 'statusToColumn must be an object' };
  const map = cleanMap(body.statusToColumn, false);
  if (map.error) return { ok: false, error: map.error };
  return { ok: true, value: { enabled: body.enabled, conflictRule: body.conflictRule, statusToColumn: map.value } };
}

/** Lenient read of a stored value: never throws, falls back to the defaults field by field. */
export function normalizeSyncConfig(stored) {
  const out = defaults();
  if (!isObject(stored)) return out;
  if (typeof stored.enabled === 'boolean') out.enabled = stored.enabled;
  if (CONFLICT_RULES.includes(stored.conflictRule)) out.conflictRule = stored.conflictRule;
  if (isObject(stored.statusToColumn)) out.statusToColumn = cleanMap(stored.statusToColumn, true).value;
  return out;
}
