import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { PluginRegistry } from '../framework/PluginRegistry.js';
import { makePlugin } from './helpers.js';

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
