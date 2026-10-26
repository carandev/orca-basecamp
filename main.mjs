import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBasecampSource } from './src/adapters/basecamp-cli.mjs';
import { createOrcaAdapter } from './src/adapters/orca.mjs';
import { createStorage } from './src/adapters/storage.mjs';
import { configFilePath, loadConfig } from './src/config.mjs';
import { openPicker } from './src/inbound/open-picker.mjs';
import { createPoller } from './src/inbound/poller.mjs';
import { createUiServer } from './src/inbound/ui-server.mjs';
import { createLinkExisting } from './src/usecases/link-existing.mjs';
import { listLinkedItems } from './src/usecases/list-linked-items.mjs';
import { createCompleteLinked } from './src/usecases/complete-linked.mjs';
import { diagnose } from './src/usecases/diagnose.mjs';
import { createOnRemoved } from './src/usecases/on-removed.mjs';
import { createOpenLinked } from './src/usecases/open-linked.mjs';
import { createStartFromItem } from './src/usecases/start-from-item.mjs';
import { createSyncConfig } from './src/usecases/sync-config.mjs';
import { createSyncLinks } from './src/usecases/sync-links.mjs';
import { orcaCli } from './orca-cli.mjs';
import { fs, openExternal, spawner } from './ports.mjs';

const SYNC_NOW_WAIT_MS = 20_000;

// The running plugin instance, so the module-level `deactivate` can stop what `activate` started.
let running = null;

const defaultDeps = {
  fs,
  spawner,
  orcaCli,
  openExternal,
  env: process.env,
  configFile: configFilePath(),
  clock: { now: () => Date.now() },
  timers: { setInterval, clearInterval, setTimeout, clearTimeout },
  createServer: ({ source, orca, startFromItem, linkItem, linkedItems, syncConfig, onConfigSaved }) =>
    createUiServer({
      source,
      orca,
      startFromItem,
      linkItem,
      linkedItems,
      syncConfig,
      onConfigSaved,
      html: () => fs.readFile(fileURLToPath(new URL('./src/inbound/ui/index.html', import.meta.url)))
    })
};

export default function activate(orca, overrides = {}) {
  deactivate();
  const deps = { ...defaultDeps, ...overrides };
  const log = (message) => orca.log(`basecamp-worktree-link: ${message}`);
  const notify = (title, body) =>
    orca.host.call('notifications.show', { title: title.slice(0, 120), body: body.slice(0, 1000) });

  const storage = createStorage((name, payload) => orca.host.call(name, payload));
  const orcaPort = createOrcaAdapter({
    orcaCli: deps.orcaCli,
    readContext: () => orca.host.call('workspace.readContext')
  });

  // The config file is read on every call, so editing it needs no restart. A broken file rejects the call,
  // and every caller below turns that into a notification.
  const withSource = async (fn) => {
    const config = await loadConfig({ configFile: deps.configFile, fs: deps.fs });
    return fn(createBasecampSource({ spawner: deps.spawner, config, env: deps.env, configFile: deps.configFile }));
  };
  const source = {
    list: (query) => withSource((s) => s.list(query)),
    projects: () => withSource((s) => s.projects()),
    get: (item) => withSource((s) => s.get(item)),
    complete: (item) => withSource((s) => s.complete(item)),
    state: (item) => withSource((s) => s.state(item)),
    reopen: (item) => withSource((s) => s.reopen(item)),
    columns: (query) => withSource((s) => s.columns(query)),
    move: (item) => withSource((s) => s.move(item))
  };

  const syncConfig = createSyncConfig({ storage });
  const loadSyncConfig = () => syncConfig.get();
  const startFromItem = createStartFromItem({ source, orca: orcaPort, storage, notify, clock: deps.clock, loadSyncConfig });
  const linkItem = createLinkExisting({ source, storage, notify, clock: deps.clock });
  const completeLinked = createCompleteLinked({ orca: orcaPort, storage, source, notify, loadSyncConfig, clock: deps.clock });
  const syncLinks = createSyncLinks({ storage, source, orca: orcaPort, notify, clock: deps.clock });
  const poller = createPoller({
    tick: () => syncLinks.tick(),
    onNotice: notify,
    timers: deps.timers,
    clock: deps.clock
  });
  const openLinked = createOpenLinked({ orca: orcaPort, storage, openExternal: deps.openExternal, notify });
  const onRemoved = createOnRemoved({ storage, source, notify });

  // Runs a command body; anything that escapes is logged and notified, never thrown into Orca.
  const guard = (name, fn) => async () => {
    try {
      await fn();
    } catch (error) {
      log(`${name} failed: ${error.message}`);
      try {
        await notify('Basecamp failed', error.message);
      } catch {
        // nothing else can be done
      }
    }
  };

  orca.commands.register(
    'diagnose',
    guard('diagnose', async () => {
      const config = await loadConfig({ configFile: deps.configFile, fs: deps.fs });
      const result = await diagnose({
        spawner: deps.spawner,
        config,
        env: deps.env,
        configFile: deps.configFile
      });
      log(`diagnose\n${result.text}`);
      await notify('Basecamp: Diagnose', result.text);
    })
  );

  // One picker server per worker, started on demand; it stops itself after idling.
  let server = null;
  const linkedItems = () => listLinkedItems({ storage });
  const ensureServer = () =>
    (server ??= deps.createServer({
      source,
      orca: orcaPort,
      startFromItem,
      linkItem,
      linkedItems,
      syncConfig,
      onConfigSaved: () => poller.ensureStarted()
    }));
  orca.commands.register(
    'start',
    guard('start', async () => {
      await openPicker({ server: ensureServer(), orca: orcaPort, openExternal: deps.openExternal, notify, log });
    })
  );

  // Links the ACTIVE worktree: the picker opens in link mode bound to a server-side session, so the page never names the target.
  orca.commands.register(
    'link',
    guard('link', async () => {
      const active = await orcaPort.resolveActiveWorktree();
      if (!active) return void (await notify('Basecamp: Link item to this worktree', 'Open a worktree first'));
      const displayName = active.displayName || basename(active.worktreePath);
      await openPicker({
        server: ensureServer(),
        orca: orcaPort,
        openExternal: deps.openExternal,
        notify,
        log,
        link: { worktreeId: active.worktreeId, displayName }
      });
    })
  );

  orca.commands.register('open-item', guard('open-item', openLinked));
  orca.commands.register('complete', guard('complete', completeLinked));

  // Runs exactly one tick and waits for it (at most 20 s). The tick notifies conflicts and failures itself.
  orca.commands.register(
    'sync-now',
    guard('sync-now', async () => {
      let timer;
      const giveUp = new Promise((resolve) => {
        timer = deps.timers.setTimeout(resolve, SYNC_NOW_WAIT_MS);
        timer.unref?.();
      });
      try {
        await Promise.race([poller.runNow(), giveUp]);
      } finally {
        deps.timers.clearTimeout(timer);
      }
    })
  );

  orca.events.on('worktree.removed', async (event) => {
    try {
      await onRemoved(event);
    } catch (error) {
      log(`worktree.removed failed: ${error.message}`);
    }
  });
  // O(1) and synchronous: Orca can emit this event often, and it only (re)starts the poller after a restart.
  orca.events.on('agent.status.changed', () => {
    try {
      poller.ensureStarted();
    } catch (error) {
      log(`agent.status.changed failed: ${error.message}`);
    }
  });

  poller.ensureStarted();
  running = {
    stop: () => {
      poller.stop();
      void server?.stop().catch(() => {});
    }
  };
}

/** Stops the poller and the picker server of the running instance. Safe to call more than once. */
export function deactivate() {
  const current = running;
  running = null;
  current?.stop();
}
