import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  ILogger,
  IPluginManifest,
  IValidationResult,
} from './interfaces.js';

// ─────────────────────────────────────────────────────────────
// Manifest JSON Schema (structural validation)
// ─────────────────────────────────────────────────────────────

/**
 * A lightweight schema descriptor used by {@link validateManifest}.
 *
 * We implement a minimal validator rather than pulling in a heavy
 * library like Ajv — the schema is small and well-known.
 */
interface FieldRule {
  readonly required: boolean;
  readonly type: string;             // typeof check
  readonly itemType?: string;        // for arrays: typeof element
  readonly objectShape?: Record<string, FieldRule>;
}

const AUTHOR_SHAPE: Record<string, FieldRule> = {
  name:  { required: true,  type: 'string' },
  email: { required: false, type: 'string' },
  url:   { required: false, type: 'string' },
};

const DEPENDENCY_SHAPE: Record<string, FieldRule> = {
  id:      { required: true, type: 'string' },
  version: { required: true, type: 'string' },
};

const RUNTIME_SHAPE: Record<string, FieldRule> = {
  engine:  { required: true, type: 'string' },
  version: { required: true, type: 'string' },
};

const MANIFEST_SCHEMA: Record<string, FieldRule> = {
  id:                 { required: true,  type: 'string' },
  name:               { required: true,  type: 'string' },
  version:            { required: true,  type: 'string' },
  description:        { required: true,  type: 'string' },
  descriptionForModel:{ required: false, type: 'string' },
  author:             { required: true,  type: 'object', objectShape: AUTHOR_SHAPE },
  dependencies:       { required: false, type: 'array',  itemType: 'object', objectShape: DEPENDENCY_SHAPE },
  capabilities:       { required: false, type: 'array',  itemType: 'string' },
  runtime:            { required: false, type: 'object', objectShape: RUNTIME_SHAPE },
  permissions:        { required: false, type: 'array',  itemType: 'string' },
  priority:           { required: false, type: 'number' },
  tags:               { required: false, type: 'array',  itemType: 'string' },
  entryPoint:         { required: false, type: 'string' },
};

// ─────────────────────────────────────────────────────────────
// Schema Validation
// ─────────────────────────────────────────────────────────────

function validateObject(
  obj: Record<string, unknown>,
  schema: Record<string, FieldRule>,
  path: string,
): string[] {
  const errors: string[] = [];

  for (const [field, rule] of Object.entries(schema)) {
    const value = obj[field];
    const fieldPath = path ? `${path}.${field}` : field;

    if (value === undefined || value === null) {
      if (rule.required) {
        errors.push(`"${fieldPath}" is required.`);
      }
      continue;
    }

    if (rule.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`"${fieldPath}" must be an array.`);
        continue;
      }
      if (rule.itemType) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i] as unknown;
          if (rule.itemType === 'object' && rule.objectShape) {
            if (typeof item !== 'object' || item === null) {
              errors.push(`"${fieldPath}[${i}]" must be an object.`);
            } else {
              errors.push(
                ...validateObject(
                  item as Record<string, unknown>,
                  rule.objectShape,
                  `${fieldPath}[${i}]`,
                ),
              );
            }
          } else if (typeof item !== rule.itemType) {
            errors.push(
              `"${fieldPath}[${i}]" must be of type "${rule.itemType}".`,
            );
          }
        }
      }
    } else if (rule.type === 'object') {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`"${fieldPath}" must be an object.`);
      } else if (rule.objectShape) {
        errors.push(
          ...validateObject(
            value as Record<string, unknown>,
            rule.objectShape,
            fieldPath,
          ),
        );
      }
    } else if (typeof value !== rule.type) {
      errors.push(`"${fieldPath}" must be of type "${rule.type}".`);
    }
  }

  return errors;
}

/**
 * Validate a raw parsed JSON object against the manifest schema.
 */
export function validateManifest(
  raw: Record<string, unknown>,
): IValidationResult {
  const errors = validateObject(raw, MANIFEST_SCHEMA, '');
  const warnings: string[] = [];

  // SemVer loose check on version field.
  if (typeof raw['version'] === 'string') {
    if (!/^\d+\.\d+\.\d+/.test(raw['version'])) {
      warnings.push(
        `"version" ("${raw['version']}") does not look like a valid SemVer string.`,
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ─────────────────────────────────────────────────────────────
// ManifestLoader
// ─────────────────────────────────────────────────────────────

/** The filename the loader looks for inside each plugin directory. */
const MANIFEST_FILENAME = 'plugin.json';

export interface ManifestLoadResult {
  /** Successfully parsed and validated manifests. */
  readonly manifests: readonly IPluginManifest[];
  /** Per-directory errors encountered during loading. */
  readonly errors: readonly { directory: string; message: string }[];
}

/**
 * Scans a plugin directory for sub-directories containing
 * `plugin.json` files, validates each against the manifest
 * schema, and returns the set of discovered manifests.
 *
 * Directory structure expected:
 * ```
 * plugins/
 *   plugin-a/
 *     plugin.json
 *     index.ts
 *   plugin-b/
 *     plugin.json
 *     index.ts
 * ```
 */
export class ManifestLoader {
  readonly #logger: ILogger;

  constructor(logger: ILogger) {
    this.#logger = logger;
  }

  /**
   * Scan `pluginDir` for plugin manifests.
   *
   * Each immediate child directory is checked for a
   * `plugin.json` file. The file is parsed and validated;
   * invalid manifests are reported as errors but do not
   * prevent other plugins from loading.
   */
  async loadFromDirectory(pluginDir: string): Promise<ManifestLoadResult> {
    const absDir = resolve(pluginDir);
    const manifests: IPluginManifest[] = [];
    const errors: { directory: string; message: string }[] = [];

    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      const msg = `Cannot read plugin directory "${absDir}": ${(err as Error).message}`;
      this.#logger.error(msg);
      return { manifests: [], errors: [{ directory: absDir, message: msg }] };
    }

    const dirs = entries.filter((e) => e.isDirectory());

    for (const dir of dirs) {
      const dirPath = join(absDir, dir.name);
      const manifestPath = join(dirPath, MANIFEST_FILENAME);

      try {
        const raw = await readFile(manifestPath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);

        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          errors.push({ directory: dirPath, message: 'plugin.json must be a JSON object.' });
          continue;
        }

        const validation = validateManifest(parsed as Record<string, unknown>);
        if (!validation.valid) {
          const detail = validation.errors.join('; ');
          errors.push({ directory: dirPath, message: `Invalid manifest: ${detail}` });
          this.#logger.warn(`Skipping "${dir.name}": ${detail}`);
          continue;
        }

        for (const w of validation.warnings) {
          this.#logger.warn(`"${dir.name}": ${w}`);
        }

        // Auto-set entryPoint relative to the plugin directory if not specified.
        const manifest = parsed as Record<string, unknown>;
        if (!manifest['entryPoint']) {
          manifest['entryPoint'] = join(dirPath, 'index.ts');
        } else if (
          typeof manifest['entryPoint'] === 'string' &&
          !manifest['entryPoint'].startsWith('/')
        ) {
          manifest['entryPoint'] = join(dirPath, manifest['entryPoint']);
        }

        manifests.push(manifest as unknown as IPluginManifest);
        this.#logger.info(`Discovered plugin "${(manifest as any).id}" in "${dir.name}".`);
      } catch (err) {
        const msg = (err as Error).message;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // No plugin.json — skip silently (not every directory is a plugin).
          continue;
        }
        errors.push({ directory: dirPath, message: `Failed to load manifest: ${msg}` });
        this.#logger.warn(`Skipping "${dir.name}": ${msg}`);
      }
    }

    return { manifests, errors };
  }
}
