import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ManifestLoader, validateManifest } from '../framework/ManifestLoader.js';

function silentLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function validManifestJson(id: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    description: `Test plugin ${id}`,
    author: { name: 'Test' },
    ...extra,
  });
}

describe('validateManifest()', () => {
  it('accepts a valid manifest', () => {
    const result = validateManifest({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      description: 'A test plugin',
      author: { name: 'Author' },
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('rejects a manifest missing required fields', () => {
    const result = validateManifest({ id: 'test' } as any);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /"name" is required/.test(e)));
    assert.ok(result.errors.some((e) => /"version" is required/.test(e)));
    assert.ok(result.errors.some((e) => /"description" is required/.test(e)));
    assert.ok(result.errors.some((e) => /"author" is required/.test(e)));
  });

  it('rejects wrong types', () => {
    const result = validateManifest({
      id: 123,
      name: 'Test',
      version: '1.0.0',
      description: 'desc',
      author: { name: 'Author' },
    } as any);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /"id" must be of type "string"/.test(e)));
  });

  it('validates nested author object', () => {
    const result = validateManifest({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      description: 'desc',
      author: { name: 123 },
    } as any);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /author\.name/.test(e)));
  });

  it('validates dependencies array items', () => {
    const result = validateManifest({
      id: 'test',
      name: 'Test',
      version: '1.0.0',
      description: 'desc',
      author: { name: 'Author' },
      dependencies: [{ id: 'dep1' }], // missing version
    } as any);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /version/.test(e)));
  });

  it('warns about non-semver version strings', () => {
    const result = validateManifest({
      id: 'test',
      name: 'Test',
      version: 'beta',
      description: 'desc',
      author: { name: 'Author' },
    });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((w) => /SemVer/.test(w)));
  });
});

describe('ManifestLoader', () => {
  let tmpDir: string;
  let loader: ManifestLoader;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'manifest-test-'));
    loader = new ManifestLoader(silentLogger());
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers plugins with plugin.json', async () => {
    const pluginDir = join(tmpDir, 'my-plugin');
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, 'plugin.json'), validManifestJson('my-plugin'));

    const result = await loader.loadFromDirectory(tmpDir);

    assert.equal(result.manifests.length, 1);
    assert.equal(result.manifests[0]!.id, 'my-plugin');
    assert.equal(result.errors.length, 0);
  });

  it('skips directories without plugin.json', async () => {
    const dir = join(tmpDir, 'not-a-plugin');
    await mkdir(dir);
    await writeFile(join(dir, 'readme.md'), '# Not a plugin');

    const result = await loader.loadFromDirectory(tmpDir);

    assert.equal(result.manifests.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it('reports invalid manifest as error', async () => {
    const pluginDir = join(tmpDir, 'bad-plugin');
    await mkdir(pluginDir);
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'bad' }), // missing required fields
    );

    const result = await loader.loadFromDirectory(tmpDir);

    assert.equal(result.manifests.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0]!.message.includes('Invalid manifest'));
  });

  it('reports malformed JSON as error', async () => {
    const pluginDir = join(tmpDir, 'broken');
    await mkdir(pluginDir);
    await writeFile(join(pluginDir, 'plugin.json'), '{ not valid json');

    const result = await loader.loadFromDirectory(tmpDir);

    assert.equal(result.manifests.length, 0);
    assert.equal(result.errors.length, 1);
  });

  it('loads multiple plugins from the same directory', async () => {
    for (const name of ['alpha', 'beta', 'gamma']) {
      const dir = join(tmpDir, name);
      await mkdir(dir);
      await writeFile(join(dir, 'plugin.json'), validManifestJson(name));
    }

    const result = await loader.loadFromDirectory(tmpDir);

    assert.equal(result.manifests.length, 3);
    const ids = result.manifests.map((m) => m.id).sort();
    assert.deepStrictEqual(ids, ['alpha', 'beta', 'gamma']);
  });

  it('auto-sets entryPoint when not specified', async () => {
    const dir = join(tmpDir, 'ep-test');
    await mkdir(dir);
    await writeFile(join(dir, 'plugin.json'), validManifestJson('ep-test'));

    const result = await loader.loadFromDirectory(tmpDir);

    assert.ok(result.manifests[0]!.entryPoint!.endsWith('index.ts'));
  });

  it('handles non-existent plugin directory', async () => {
    const result = await loader.loadFromDirectory('/tmp/definitely-not-a-dir-12345');

    assert.equal(result.manifests.length, 0);
    assert.equal(result.errors.length, 1);
  });
});
