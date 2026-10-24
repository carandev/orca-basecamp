import { fileURLToPath } from 'node:url';
import { createBasecampSource } from './src/adapters/basecamp-cli.mjs';
import { createOrcaAdapter } from './src/adapters/orca.mjs';
import { createStorage } from './src/adapters/storage.mjs';
import { configFilePath, loadConfig } from './src/config.mjs';
import { openPicker } from './src/inbound/open-picker.mjs';
import { createUiServer } from './src/inbound/ui-server.mjs';
import { createCompleteLinked } from './src/usecases/complete-linked.mjs';
import { diagnose } from './src/usecases/diagnose.mjs';
import { createOnRemoved } from './src/usecases/on-removed.mjs';
import { createOpenLinked } from './src/usecases/open-linked.mjs';
import { createStartFromItem } from './src/usecases/start-from-item.mjs';
import { orcaCli } from './orca-cli.mjs';
import { fs, openExternal, spawner } from './ports.mjs';

const defaultDeps = {
  fs,
  spawner,
  orcaCli,
  openExternal,
  env: process.env,
  configFile: configFilePath(),
  clock: { now: () => Date.now() },
  createServer: ({ source, orca, startFromItem }) =>
    createUiServer({
      source,
      orca,
      startFromItem,
      html: () => fs.readFile(fileURLToPath(new URL('./src/inbound/ui/index.html', import.meta.url)))
    })
};

export default function activate(orca, overrides = {}) {
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
    complete: (item) => withSource((s) => s.complete(item))
  };

  const startFromItem = createStartFromItem({ source, orca: orcaPort, storage, notify, clock: deps.clock });
  const completeLinked = createCompleteLinked({ orca: orcaPort, storage, source, notify });
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
  orca.commands.register(
    'start',
    guard('start', async () => {
      server ??= deps.createServer({ source, orca: orcaPort, startFromItem });
      await openPicker({ server, orca: orcaPort, openExternal: deps.openExternal, notify, log });
    })
  );

  orca.commands.register('open-item', guard('open-item', openLinked));
  orca.commands.register('complete', guard('complete', completeLinked));

  orca.events.on('worktree.removed', async (event) => {
    try {
      await onRemoved(event);
    } catch (error) {
      log(`worktree.removed failed: ${error.message}`);
    }
  });
}
