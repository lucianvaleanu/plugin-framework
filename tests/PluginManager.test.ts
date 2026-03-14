import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PluginManager } from '../framework/PluginManager.js';
import { PluginRegistry } from '../framework/PluginRegistry.js';
import { EventBus } from '../framework/EventBus.js';
import { PluginLifecycleState } from '../framework/interfaces.js';
import type {
  IHostAPI,
  ILogger,
  IPlugin,
  IPluginContext,
  IPluginLifecycleHooks,
  IPluginManifest,
  IPluginRegistry,
  IStorage,
} from '../framework/interfaces.js';
import { makeManifest, makePlugin } from './helpers.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

/** No-op logger that silently swallows all output. */
function makeLogger(): ILogger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/** Minimal IStorage stub. */
function makeStorage(): IStorage {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T>(_key: string, value: T) {
      store.set(_key, value);
    },
    async delete(key: string) {
      return store.delete(key);
    },
    async has(key: string) {
      return store.has(key);
    },
    async clear() {
      store.clear();
    },
  };
}

/** Minimal IHostAPI stub. */
function makeHostApi(): IHostAPI {
  const logger = makeLogger();
  const events = new EventBus();
  return {
    logger,
    storage: makeStorage(),
    config: {
      get: () => undefined,
      has: () => false,
      getAll: () => ({}),
    },
    events,
    services: {
      register() {},
      unregister() {
        return false;
      },
      async resolve() {
        return undefined as any;
      },
      has() {
        return false;
      },
      list() {
        return [];
      },
    },
  };
}

/** Build a PluginManager with default test dependencies. */
function makeManager(registry?: IPluginRegistry) {
  const reg = registry ?? new PluginRegistry();
  const events = new EventBus();
  const hostApi = makeHostApi();
  const logger = makeLogger();
  return { manager: new PluginManager(reg, events, hostApi, logger), registry: reg };
}

/** Create a plugin with optional lifecycle hooks. */
function makePluginWithHooks(
  id: string,
  hooks: Partial<IPluginLifecycleHooks> = {},
): IPlugin & Partial<IPluginLifecycleHooks> {
  const base = makePlugin(id);
  return { ...base, ...hooks };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('PluginManager', () => {
  let registry: PluginRegistry;
  let manager: PluginManager;

  beforeEach(() => {
    registry = new PluginRegistry();
    const result = makeManager(registry);
    manager = result.manager;
  });

  // ── install ──────────────────────────────────────────────

  describe('install()', () => {
    it('installs a pre-registered plugin and transitions to Installed', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);

      const result = await manager.install(plugin.manifest);

      assert.strictEqual(result, plugin);
      assert.equal(manager.getState('p1'), PluginLifecycleState.Installed);
    });

    it('calls initialize() on the plugin during install', async () => {
      let initialized = false;
      const plugin = makePlugin('p1');
      plugin.initialize = async () => {
        initialized = true;
      };
      registry.register(plugin);

      await manager.install(plugin.manifest);

      assert.equal(initialized, true);
    });

    it('calls onInstall lifecycle hook before initialize', async () => {
      const order: string[] = [];
      const plugin = makePluginWithHooks('p1', {
        async onInstall() {
          order.push('onInstall');
        },
      });
      plugin.initialize = async () => {
        order.push('initialize');
      };
      registry.register(plugin);

      await manager.install(plugin.manifest);

      assert.deepStrictEqual(order, ['onInstall', 'initialize']);
    });

    it('transitions to Error when initialize throws', async () => {
      const plugin = makePlugin('p1');
      plugin.initialize = async () => {
        throw new Error('init boom');
      };
      registry.register(plugin);

      await assert.rejects(
        () => manager.install(plugin.manifest),
        /failed to install/,
      );
      assert.equal(manager.getState('p1'), PluginLifecycleState.Error);
    });

    it('transitions to Error when onInstall hook throws', async () => {
      const plugin = makePluginWithHooks('p1', {
        async onInstall() {
          throw new Error('hook boom');
        },
      });
      registry.register(plugin);

      await assert.rejects(
        () => manager.install(plugin.manifest),
        /failed to install/,
      );
      assert.equal(manager.getState('p1'), PluginLifecycleState.Error);
    });
  });

  // ── activate ─────────────────────────────────────────────

  describe('activate()', () => {
    it('transitions Installed → Activated', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await manager.activate('p1');

      assert.equal(manager.getState('p1'), PluginLifecycleState.Activated);
    });

    it('calls onActivate lifecycle hook', async () => {
      let hooked = false;
      const plugin = makePluginWithHooks('p1', {
        async onActivate() {
          hooked = true;
        },
      });
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await manager.activate('p1');

      assert.equal(hooked, true);
    });

    it('rejects activation of a disabled plugin', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.disable('p1');

      await assert.rejects(
        () => manager.activate('p1'),
        /disabled/,
      );
    });

    it('rejects invalid transition (Discovered → Activated)', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      // Plugin is in the registry but manager has no tracked state yet.
      assert.equal(manager.getState('p1'), undefined);

      await assert.rejects(
        () => manager.activate('p1'),
        /no tracked state/,
      );
    });

    it('transitions to Error when onActivate throws', async () => {
      const plugin = makePluginWithHooks('p1', {
        async onActivate() {
          throw new Error('activate boom');
        },
      });
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await assert.rejects(
        () => manager.activate('p1'),
        /failed to activate/,
      );
      assert.equal(manager.getState('p1'), PluginLifecycleState.Error);
    });

    it('supports re-activation (Deactivated → Activated)', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');
      await manager.deactivate('p1');

      await manager.activate('p1');

      assert.equal(manager.getState('p1'), PluginLifecycleState.Activated);
    });
  });

  // ── deactivate ───────────────────────────────────────────

  describe('deactivate()', () => {
    it('transitions Activated → Deactivated', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');

      await manager.deactivate('p1');

      assert.equal(manager.getState('p1'), PluginLifecycleState.Deactivated);
    });

    it('calls onDeactivate hook then shutdown()', async () => {
      const order: string[] = [];
      const plugin = makePluginWithHooks('p1', {
        async onDeactivate() {
          order.push('onDeactivate');
        },
      });
      plugin.shutdown = async () => {
        order.push('shutdown');
      };
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');

      await manager.deactivate('p1');

      assert.deepStrictEqual(order, ['onDeactivate', 'shutdown']);
    });

    it('rejects deactivation from Installed state', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await assert.rejects(
        () => manager.deactivate('p1'),
        /invalid transition/,
      );
    });

    it('transitions to Error when shutdown throws', async () => {
      const plugin = makePlugin('p1');
      plugin.shutdown = async () => {
        throw new Error('shutdown boom');
      };
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');

      await assert.rejects(
        () => manager.deactivate('p1'),
        /failed to deactivate/,
      );
      assert.equal(manager.getState('p1'), PluginLifecycleState.Error);
    });
  });

  // ── uninstall ────────────────────────────────────────────

  describe('uninstall()', () => {
    it('uninstalls an Installed plugin and removes it', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await manager.uninstall('p1');

      assert.equal(manager.getPlugin('p1'), undefined);
      assert.equal(manager.getState('p1'), undefined);
    });

    it('auto-deactivates before uninstalling an active plugin', async () => {
      let shutdownCalled = false;
      const plugin = makePlugin('p1');
      plugin.shutdown = async () => {
        shutdownCalled = true;
      };
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');

      await manager.uninstall('p1');

      assert.equal(shutdownCalled, true);
      assert.equal(manager.getPlugin('p1'), undefined);
    });

    it('calls onUninstall lifecycle hook', async () => {
      let hooked = false;
      const plugin = makePluginWithHooks('p1', {
        async onUninstall() {
          hooked = true;
        },
      });
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await manager.uninstall('p1');

      assert.equal(hooked, true);
    });

    it('transitions to Error when onUninstall throws', async () => {
      const plugin = makePluginWithHooks('p1', {
        async onUninstall() {
          throw new Error('uninstall boom');
        },
      });
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await assert.rejects(
        () => manager.uninstall('p1'),
        /failed to uninstall/,
      );
    });
  });

  // ── unload ───────────────────────────────────────────────

  describe('unload()', () => {
    it('removes the plugin from the registry', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await manager.unload('p1');

      assert.equal(registry.has('p1'), false);
      assert.equal(manager.getState('p1'), undefined);
    });

    it('auto-deactivates an active plugin before unloading', async () => {
      let shutdownCalled = false;
      const plugin = makePlugin('p1');
      plugin.shutdown = async () => {
        shutdownCalled = true;
      };
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');

      await manager.unload('p1');

      assert.equal(shutdownCalled, true);
    });

    it('throws for unknown plugin', async () => {
      await assert.rejects(
        () => manager.unload('nope'),
        /not loaded/,
      );
    });
  });

  // ── enable / disable ─────────────────────────────────────

  describe('enable() / disable()', () => {
    it('enable allows subsequent activation', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.disable('p1');
      await manager.enable('p1');

      await manager.activate('p1');

      assert.equal(manager.getState('p1'), PluginLifecycleState.Activated);
    });

    it('disable deactivates an active plugin', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);
      await manager.activate('p1');

      await manager.disable('p1');

      assert.equal(manager.getState('p1'), PluginLifecycleState.Deactivated);
    });

    it('throws for unknown plugin', async () => {
      await assert.rejects(() => manager.enable('nope'), /not loaded/);
      await assert.rejects(() => manager.disable('nope'), /not loaded/);
    });
  });

  // ── query methods ────────────────────────────────────────

  describe('getPlugin() / getAllPlugins() / getState()', () => {
    it('getPlugin returns plugin by ID', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      assert.strictEqual(manager.getPlugin('p1'), plugin);
    });

    it('getPlugin returns undefined for unknown ID', () => {
      assert.equal(manager.getPlugin('nope'), undefined);
    });

    it('getAllPlugins returns all managed plugins', async () => {
      const p1 = makePlugin('p1');
      const p2 = makePlugin('p2');
      registry.register(p1);
      registry.register(p2);
      await manager.install(p1.manifest);
      await manager.install(p2.manifest);

      const all = manager.getAllPlugins();
      const ids = all.map((p) => p.manifest.id).sort();
      assert.deepStrictEqual(ids, ['p1', 'p2']);
    });

    it('getState returns undefined for unknown plugin', () => {
      assert.equal(manager.getState('nope'), undefined);
    });
  });

  // ── error containment ────────────────────────────────────

  describe('error containment', () => {
    it('a failing plugin does not prevent others from installing', async () => {
      const good = makePlugin('good');
      const bad = makePlugin('bad');
      bad.initialize = async () => {
        throw new Error('init boom');
      };

      registry.register(good);
      registry.register(bad);

      // Bad fails...
      await assert.rejects(() => manager.install(bad.manifest));

      // ...but good installs fine.
      await manager.install(good.manifest);
      assert.equal(manager.getState('good'), PluginLifecycleState.Installed);
    });

    it('a failing plugin does not prevent others from activating', async () => {
      const good = makePlugin('good');
      const bad = makePluginWithHooks('bad', {
        async onActivate() {
          throw new Error('activate boom');
        },
      });

      registry.register(good);
      registry.register(bad);
      await manager.install(good.manifest);
      await manager.install(bad.manifest);

      // Bad fails activation...
      await assert.rejects(() => manager.activate('bad'));
      assert.equal(manager.getState('bad'), PluginLifecycleState.Error);

      // ...but good activates fine.
      await manager.activate('good');
      assert.equal(manager.getState('good'), PluginLifecycleState.Activated);
    });
  });

  // ── state machine guards ─────────────────────────────────

  describe('state machine guards', () => {
    it('rejects Installed → Deactivated', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await assert.rejects(
        () => manager.deactivate('p1'),
        /invalid transition/,
      );
    });

    it('rejects double install', async () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      await manager.install(plugin.manifest);

      await assert.rejects(
        () => manager.install(plugin.manifest),
        /invalid transition/,
      );
    });
  });
});
