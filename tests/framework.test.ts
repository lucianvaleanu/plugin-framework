import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { ServiceRegistry } from '../framework/ServiceRegistry.js';
import { PluginRegistry } from '../framework/PluginRegistry.js';
import { ServiceScope, PluginLifecycleState } from '../framework/interfaces.js';
import type {
  IPlugin,
  IPluginContext,
  IPluginManifest,
  IServiceDescriptor,
} from '../framework/interfaces.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

/** Minimal manifest stub for test contexts. */
function makeManifest(id: string): IPluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: `Test plugin ${id}`,
    author: { name: 'Test' },
  };
}

/** Minimal plugin stub for PluginRegistry tests. */
function makePlugin(
  id: string,
  opts: { capabilities?: string[]; enabled?: boolean } = {},
): IPlugin {
  return {
    manifest: {
      ...makeManifest(id),
      capabilities: opts.capabilities,
    },
    state: PluginLifecycleState.Discovered,
    isEnabled: opts.enabled ?? true,
    isReady: false,
    async initialize() {},
    async execute() { return undefined as any; },
    async configure() {},
    canHandle() { return false; },
    async shutdown() {},
  };
}

/** Minimal plugin context stub. */
function makeContext(pluginId: string): IPluginContext {
  return {
    manifest: makeManifest(pluginId),
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    storage: {} as IPluginContext['storage'],
    host: {} as IPluginContext['host'],
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('ServiceRegistry', () => {
  let registry: ServiceRegistry;
  const hostContext = makeContext('__host__');

  beforeEach(() => {
    registry = new ServiceRegistry(hostContext);
  });

  // ── register / has / list ───────────────────────────────

  describe('register()', () => {
    it('adds a service descriptor', () => {
      const desc: IServiceDescriptor<string> = {
        id: 'svc.greeting',
        scope: ServiceScope.Root,
        factory: () => 'hello',
      };
      registry.register(desc);

      assert.equal(registry.has('svc.greeting'), true);
      assert.equal(registry.list().length, 1);
      assert.equal(registry.list()[0]!.id, 'svc.greeting');
    });

    it('throws on duplicate registration', () => {
      const desc: IServiceDescriptor<string> = {
        id: 'svc.dup',
        scope: ServiceScope.Root,
        factory: () => 'x',
      };
      registry.register(desc);

      assert.throws(
        () => registry.register(desc),
        /already registered/,
      );
    });
  });

  // ── unregister ──────────────────────────────────────────

  describe('unregister()', () => {
    it('removes a registered service and returns true', () => {
      registry.register({
        id: 'svc.remove',
        scope: ServiceScope.Root,
        factory: () => 42,
      });
      assert.equal(registry.unregister('svc.remove'), true);
      assert.equal(registry.has('svc.remove'), false);
    });

    it('returns false for unknown service', () => {
      assert.equal(registry.unregister('svc.nope'), false);
    });
  });

  // ── has ─────────────────────────────────────────────────

  describe('has()', () => {
    it('returns false for unregistered service', () => {
      assert.equal(registry.has('svc.ghost'), false);
    });
  });

  // ── list ────────────────────────────────────────────────

  describe('list()', () => {
    it('returns empty array when no services registered', () => {
      assert.deepStrictEqual(registry.list(), []);
    });

    it('returns all registered descriptors', () => {
      registry.register({ id: 'a', scope: ServiceScope.Root, factory: () => 1 });
      registry.register({ id: 'b', scope: ServiceScope.Transient, factory: () => 2 });

      const ids = registry.list().map((d) => d.id).sort();
      assert.deepStrictEqual(ids, ['a', 'b']);
    });
  });

  // ── resolve — Root scope ────────────────────────────────

  describe('resolve() — Root scope', () => {
    it('creates an instance via the factory', async () => {
      registry.register({
        id: 'svc.root',
        scope: ServiceScope.Root,
        factory: () => ({ value: 42 }),
      });

      const instance = await registry.resolve<{ value: number }>('svc.root');
      assert.equal(instance.value, 42);
    });

    it('returns the same cached instance on subsequent calls', async () => {
      let callCount = 0;
      registry.register({
        id: 'svc.singleton',
        scope: ServiceScope.Root,
        factory: () => {
          callCount++;
          return { n: callCount };
        },
      });

      const first = await registry.resolve('svc.singleton');
      const second = await registry.resolve('svc.singleton');

      assert.strictEqual(first, second, 'Root-scoped must return the same reference');
      assert.equal(callCount, 1, 'Factory should only be called once');
    });

    it('supports async factories', async () => {
      registry.register({
        id: 'svc.async',
        scope: ServiceScope.Root,
        factory: async () => {
          return { ready: true };
        },
      });

      const instance = await registry.resolve<{ ready: boolean }>('svc.async');
      assert.equal(instance.ready, true);
    });
  });

  // ── resolve — Transient scope ───────────────────────────

  describe('resolve() — Transient scope', () => {
    it('returns a new instance every time', async () => {
      let callCount = 0;
      registry.register({
        id: 'svc.transient',
        scope: ServiceScope.Transient,
        factory: () => {
          callCount++;
          return { n: callCount };
        },
      });

      const a = await registry.resolve<{ n: number }>('svc.transient');
      const b = await registry.resolve<{ n: number }>('svc.transient');

      assert.notStrictEqual(a, b, 'Transient must return different references');
      assert.equal(a.n, 1);
      assert.equal(b.n, 2);
    });
  });

  // ── resolve — Plugin scope ──────────────────────────────

  describe('resolveForPlugin() — Plugin scope', () => {
    it('returns the same instance for the same plugin', async () => {
      let callCount = 0;
      registry.register({
        id: 'svc.plugin',
        scope: ServiceScope.Plugin,
        factory: () => {
          callCount++;
          return { n: callCount };
        },
      });

      const ctxA = makeContext('plugin-alpha');
      const first = await registry.resolveForPlugin('svc.plugin', ctxA);
      const second = await registry.resolveForPlugin('svc.plugin', ctxA);

      assert.strictEqual(first, second, 'Same plugin must get the same instance');
      assert.equal(callCount, 1);
    });

    it('returns different instances for different plugins', async () => {
      let callCount = 0;
      registry.register({
        id: 'svc.plugin',
        scope: ServiceScope.Plugin,
        factory: () => {
          callCount++;
          return { n: callCount };
        },
      });

      const ctxA = makeContext('plugin-alpha');
      const ctxB = makeContext('plugin-beta');

      const instanceA = await registry.resolveForPlugin<{ n: number }>('svc.plugin', ctxA);
      const instanceB = await registry.resolveForPlugin<{ n: number }>('svc.plugin', ctxB);

      assert.notStrictEqual(instanceA, instanceB, 'Different plugins must get different instances');
      assert.equal(instanceA.n, 1);
      assert.equal(instanceB.n, 2);
    });
  });

  // ── resolve — error paths ──────────────────────────────

  describe('resolve() — errors', () => {
    it('throws when service is not registered', async () => {
      await assert.rejects(
        () => registry.resolve('svc.missing'),
        /no service registered/,
      );
    });
  });

  // ── unregister cleans caches ───────────────────────────

  describe('unregister() clears cached instances', () => {
    it('root-scoped cache is cleared on unregister', async () => {
      let callCount = 0;
      registry.register({
        id: 'svc.cached',
        scope: ServiceScope.Root,
        factory: () => {
          callCount++;
          return { n: callCount };
        },
      });

      const first = await registry.resolve<{ n: number }>('svc.cached');
      assert.equal(first.n, 1);

      registry.unregister('svc.cached');

      // Re-register and resolve — should get a fresh instance
      registry.register({
        id: 'svc.cached',
        scope: ServiceScope.Root,
        factory: () => {
          callCount++;
          return { n: callCount };
        },
      });

      const second = await registry.resolve<{ n: number }>('svc.cached');
      assert.equal(second.n, 2, 'After unregister + re-register, factory should run again');
    });
  });
});

// ─────────────────────────────────────────────────────────────
// PluginRegistry
// ─────────────────────────────────────────────────────────────

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  describe('register()', () => {
    it('adds a plugin', () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      assert.equal(registry.has('p1'), true);
    });

    it('throws on duplicate registration', () => {
      registry.register(makePlugin('p1'));
      assert.throws(() => registry.register(makePlugin('p1')), /already registered/);
    });
  });

  describe('unregister()', () => {
    it('removes a registered plugin and returns true', () => {
      registry.register(makePlugin('p1'));
      assert.equal(registry.unregister('p1'), true);
      assert.equal(registry.has('p1'), false);
    });

    it('returns false for unknown plugin', () => {
      assert.equal(registry.unregister('nope'), false);
    });
  });

  describe('get()', () => {
    it('returns the plugin if registered', () => {
      const plugin = makePlugin('p1');
      registry.register(plugin);
      assert.strictEqual(registry.get('p1'), plugin);
    });

    it('returns undefined for unknown plugin', () => {
      assert.equal(registry.get('nope'), undefined);
    });
  });

  describe('getAll()', () => {
    it('returns empty array when empty', () => {
      assert.deepStrictEqual(registry.getAll(), []);
    });

    it('returns all registered plugins', () => {
      registry.register(makePlugin('a'));
      registry.register(makePlugin('b'));
      const ids = registry.getAll().map((p) => p.manifest.id).sort();
      assert.deepStrictEqual(ids, ['a', 'b']);
    });
  });

  describe('has()', () => {
    it('returns false for unregistered plugin', () => {
      assert.equal(registry.has('ghost'), false);
    });
  });

  describe('filter()', () => {
    it('returns plugins matching predicate', () => {
      registry.register(makePlugin('a', { enabled: true }));
      registry.register(makePlugin('b', { enabled: false }));
      registry.register(makePlugin('c', { enabled: true }));

      const enabled = registry.filter((p) => p.isEnabled);
      const ids = enabled.map((p) => p.manifest.id).sort();
      assert.deepStrictEqual(ids, ['a', 'c']);
    });

    it('returns empty array when nothing matches', () => {
      registry.register(makePlugin('a'));
      assert.deepStrictEqual(registry.filter(() => false), []);
    });
  });

  describe('findByCapability()', () => {
    it('returns plugins that declare the capability', () => {
      registry.register(makePlugin('a', { capabilities: ['render', 'export'] }));
      registry.register(makePlugin('b', { capabilities: ['export'] }));
      registry.register(makePlugin('c'));

      const exporters = registry.findByCapability('export');
      const ids = exporters.map((p) => p.manifest.id).sort();
      assert.deepStrictEqual(ids, ['a', 'b']);
    });

    it('returns empty array when no plugin has the capability', () => {
      registry.register(makePlugin('a', { capabilities: ['render'] }));
      assert.deepStrictEqual(registry.findByCapability('export'), []);
    });

    it('handles plugins with no capabilities declared', () => {
      registry.register(makePlugin('a'));
      assert.deepStrictEqual(registry.findByCapability('anything'), []);
    });
  });
});
