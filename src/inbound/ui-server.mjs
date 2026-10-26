import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

const NUMERIC = /^\d+$/;
const AGENT = /^[\w.-]{1,40}$/;
const KINDS = ['todo', 'card'];

function tokenMatches(given, expected) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A numeric id as a string (so it can never be read as a flag by the CLI), or null. */
function numericId(value) {
  const text = typeof value === 'number' && Number.isInteger(value) && value >= 0 ? String(value) : value;
  return typeof text === 'string' && NUMERIC.test(text) ? text : null;
}

/**
 * Localhost-only picker server. It trusts nothing from the page except ids: `/api/start` carries
 * `{type, id, projectId, repoId, agent?}` and the item itself is refetched by `startFromItem`.
 * Ports: source {list, projects, columns} (the basecamp CLI), orca {listRepos}, startFromItem(request) -> status object,
 * syncConfig {get, save} (the stored sync settings) and onConfigSaved() (called after a successful save).
 * `html` is the page body (a string, or a function returning it, possibly async). `token` defaults to a fresh
 * random value. Shuts itself down after `idleMs` without requests.
 * Returns { start() -> { url, port, token } (reuses a running server), stop(), isRunning() }.
 */
export function createUiServer({
  source,
  orca,
  startFromItem,
  syncConfig,
  onConfigSaved = () => {},
  html,
  token = randomBytes(24).toString('hex'),
  idleMs = 15 * 60_000,
  maxBodyBytes = 256 * 1024
}) {
  let server = null;
  let port = 0;
  let idleTimer = null;
  let starting = null;

  const urlOf = () => `http://127.0.0.1:${port}/?token=${token}`;

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop(), idleMs);
    idleTimer.unref();
  }

  function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  const fail = (res, status, error, extra = {}) => send(res, status, { ok: false, error, ...extra });

  /** A failure of a port: CLI errors carry code, hint and retryable (shown, never acted on). */
  const portFailure = (res, error) => {
    const extra = {};
    if (error?.hint) extra.hint = error.hint;
    if (error?.code) extra.code = error.code;
    if (error?.retryable !== undefined) extra.retryable = error.retryable;
    return fail(res, error?.code === 'invalid_argument' ? 400 : 502, error?.message ?? String(error), extra);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBodyBytes) {
          reject(Object.assign(new Error('Request body too large'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function items(res, url) {
    const kind = url.searchParams.get('kind');
    if (!KINDS.includes(kind)) return fail(res, 400, 'kind must be "todo" or "card"');
    const query = { kind };
    if (kind === 'card') {
      const projectId = numericId(url.searchParams.get('projectId'));
      if (projectId === null) return fail(res, 400, 'projectId must be a numeric id');
      query.projectId = projectId;
    }
    try {
      const { items: list, notice } = await source.list(query);
      return send(res, 200, { ok: true, items: list, ...(notice ? { notice } : {}) });
    } catch (error) {
      return portFailure(res, error);
    }
  }

  async function columns(res, url) {
    const projectId = numericId(url.searchParams.get('projectId'));
    if (projectId === null) return fail(res, 400, 'projectId must be a numeric id');
    try {
      return send(res, 200, { ok: true, columns: await source.columns({ projectId }) });
    } catch (error) {
      return portFailure(res, error);
    }
  }

  /** Shared POST checks (Origin, Content-Type, size, JSON object). Sends the failure and returns null, or returns the body. */
  async function postedObject(req, res, origins) {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.some((o) => origin === `http://${o}`)) return void fail(res, 403, 'Bad Origin');
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
      return void fail(res, 415, 'Content-Type must be application/json');
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return void (e.status ? fail(res, e.status, e.message) : fail(res, 400, `Invalid JSON: ${e.message}`));
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return void fail(res, 400, 'Expected a JSON object');
    return body;
  }

  async function saveSyncConfig(req, res, origins) {
    const body = await postedObject(req, res, origins);
    if (!body) return;
    try {
      const saved = await syncConfig.save(body);
      if (!saved.ok) return fail(res, 400, saved.error);
      onConfigSaved();
      return send(res, 200, { ok: true, config: saved.value });
    } catch (error) {
      return portFailure(res, error);
    }
  }

  async function start_(req, res, origins) {
    const body = await postedObject(req, res, origins);
    if (!body) return;
    const id = numericId(body.id);
    const projectId = numericId(body.projectId);
    if (!KINDS.includes(body.type)) return fail(res, 400, 'type must be "todo" or "card"');
    if (id === null || projectId === null) return fail(res, 400, 'id and projectId must be numeric ids');
    if (body.agent !== undefined && !(typeof body.agent === 'string' && AGENT.test(body.agent))) {
      return fail(res, 400, 'agent must match [A-Za-z0-9_.-]{1,40}');
    }
    if (typeof body.repoId !== 'string' || !body.repoId) return fail(res, 400, 'A repository is required');
    let repos;
    try {
      repos = await orca.listRepos();
    } catch (error) {
      return portFailure(res, error);
    }
    if (!repos.some((r) => r.id === body.repoId)) return fail(res, 400, 'Unknown repository');

    // Only ids go on: the title, description and prompt come from the source, never from the page.
    const result = await startFromItem({ type: body.type, id, projectId, repoId: body.repoId, agent: body.agent });
    if (result.status === 'linked') return send(res, 200, { ok: true, status: 'linked', worktreeId: result.worktreeId, name: result.name });
    if (result.status === 'unlinked') return send(res, 200, { ok: true, status: 'unlinked', name: result.name });
    if (result.status === 'in_flight') return fail(res, 409, 'This item is already being started');
    return fail(res, 502, result.error ?? 'Start failed', result.hint ? { hint: result.hint } : {});
  }

  async function handle(req, res) {
    touch();
    const origins = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!origins.includes(req.headers.host)) return fail(res, 403, 'Bad Host header');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/') {
      if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
      if (!tokenMatches(url.searchParams.get('token'), token)) return fail(res, 403, 'Invalid token');
      const page = typeof html === 'function' ? await html() : html;
      if (page == null) return fail(res, 500, 'Picker page is missing');
      return send(res, 200, page, 'text/html; charset=utf-8', { 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer' });
    }
    const allowed = {
      '/api/repos': 'GET',
      '/api/projects': 'GET',
      '/api/items': 'GET',
      '/api/columns': 'GET',
      '/api/sync-config': ['GET', 'POST'],
      '/api/start': 'POST'
    }[url.pathname];
    if (!allowed) return fail(res, 404, 'Not found');
    if (![allowed].flat().includes(req.method)) return fail(res, 405, 'Method not allowed');
    if (!tokenMatches(req.headers['x-token'], token)) return fail(res, 403, 'Invalid token');

    if (url.pathname === '/api/start') return start_(req, res, origins);
    if (url.pathname === '/api/items') return items(res, url);
    if (url.pathname === '/api/columns') return columns(res, url);
    if (url.pathname === '/api/sync-config') {
      if (req.method === 'POST') return saveSyncConfig(req, res, origins);
      try {
        return send(res, 200, { ok: true, config: await syncConfig.get() });
      } catch (error) {
        return portFailure(res, error);
      }
    }
    try {
      if (url.pathname === '/api/repos') return send(res, 200, { ok: true, repos: await orca.listRepos() });
      return send(res, 200, { ok: true, projects: await source.projects() });
    } catch (error) {
      return portFailure(res, error);
    }
  }

  async function start() {
    if (server) return { url: urlOf(), port, token };
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          if (!res.headersSent) fail(res, 500, e.message);
          else res.end();
        });
      });
      s.once('error', reject);
      s.listen(0, '127.0.0.1', () => {
        s.removeListener('error', reject);
        server = s;
        port = s.address().port;
        touch();
        resolve({ url: urlOf(), port, token });
      });
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function stop() {
    clearTimeout(idleTimer);
    const s = server;
    server = null;
    if (!s) return;
    await new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  return { start, stop, isRunning: () => server !== null };
}
