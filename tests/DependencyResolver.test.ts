import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DependencyResolver } from '../framework/DependencyResolver.js';
import { makeManifest } from './helpers.js';
import type { IPluginManifest } from '../framework/interfaces.js';

function manifestWithDeps(
  id: string,
  deps: { id: string; version: string }[],
): IPluginManifest {
  return { ...makeManifest(id), dependencies: deps };
}

describe('DependencyResolver', () => {
  const resolver = new DependencyResolver();

  // ── resolve (topological sort) ──────────────────────────

  describe('resolve()', () => {
    it('returns plugins with no dependencies in sorted order', () => {
      const manifests = [makeManifest('c'), makeManifest('a'), makeManifest('b')];
      const order = resolver.resolve(manifests);
      assert.deepStrictEqual(order, ['a', 'b', 'c']);
    });

    it('places dependencies before dependents', () => {
      const manifests = [
        manifestWithDeps('app', [{ id: 'db', version: '^1.0.0' }]),
        makeManifest('db'),
      ];
      const order = resolver.resolve(manifests);
      assert.ok(order.indexOf('db') < order.indexOf('app'));
    });

    it('handles a diamond dependency graph', () => {
      //   A
      //  / \
      // B   C
      //  \ /
      //   D
      const manifests = [
        manifestWithDeps('A', [
          { id: 'B', version: '*' },
          { id: 'C', version: '*' },
        ]),
        manifestWithDeps('B', [{ id: 'D', version: '*' }]),
        manifestWithDeps('C', [{ id: 'D', version: '*' }]),
        makeManifest('D'),
      ];
      const order = resolver.resolve(manifests);

      assert.ok(order.indexOf('D') < order.indexOf('B'));
      assert.ok(order.indexOf('D') < order.indexOf('C'));
      assert.ok(order.indexOf('B') < order.indexOf('A'));
      assert.ok(order.indexOf('C') < order.indexOf('A'));
    });

    it('handles a chain A → B → C', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'B', version: '*' }]),
        manifestWithDeps('B', [{ id: 'C', version: '*' }]),
        makeManifest('C'),
      ];
      const order = resolver.resolve(manifests);
      assert.deepStrictEqual(order, ['C', 'B', 'A']);
    });

    it('skips host dependencies', () => {
      const manifests = [
        manifestWithDeps('plugin', [{ id: 'host', version: '^1.0.0' }]),
      ];
      const order = resolver.resolve(manifests);
      assert.deepStrictEqual(order, ['plugin']);
    });
  });

  // ── validate ────────────────────────────────────────────

  describe('validate()', () => {
    it('reports missing dependencies', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'missing', version: '^1.0.0' }]),
      ];
      const result = resolver.validate(manifests);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => /missing/.test(e)));
    });

    it('reports circular dependencies', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'B', version: '*' }]),
        manifestWithDeps('B', [{ id: 'A', version: '*' }]),
      ];
      const result = resolver.validate(manifests);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => /[Cc]ircular/.test(e)));
    });

    it('detects a three-node cycle', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'B', version: '*' }]),
        manifestWithDeps('B', [{ id: 'C', version: '*' }]),
        manifestWithDeps('C', [{ id: 'A', version: '*' }]),
      ];
      const result = resolver.validate(manifests);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => /[Cc]ircular/.test(e)));
    });

    it('warns about host dependencies', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'host', version: '^1.0.0' }]),
      ];
      const result = resolver.validate(manifests);
      assert.equal(result.valid, true);
      assert.ok(result.warnings.length > 0);
    });

    it('returns valid for a correct graph', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'B', version: '*' }]),
        makeManifest('B'),
      ];
      const result = resolver.validate(manifests);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });
  });

  // ── resolve errors ──────────────────────────────────────

  describe('resolve() — error paths', () => {
    it('throws on circular dependency', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'B', version: '*' }]),
        manifestWithDeps('B', [{ id: 'A', version: '*' }]),
      ];
      assert.throws(() => resolver.resolve(manifests), /cannot resolve/);
    });

    it('throws on missing dependency', () => {
      const manifests = [
        manifestWithDeps('A', [{ id: 'ghost', version: '*' }]),
      ];
      assert.throws(() => resolver.resolve(manifests), /cannot resolve/);
    });
  });
});
