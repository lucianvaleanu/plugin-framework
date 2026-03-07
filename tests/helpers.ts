import { PluginLifecycleState } from '../framework/interfaces.js';
import type {
  IPlugin,
  IPluginContext,
  IPluginManifest,
} from '../framework/interfaces.js';

/** Minimal manifest stub for test contexts. */
export function makeManifest(id: string): IPluginManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: `Test plugin ${id}`,
    author: { name: 'Test' },
  };
}

/** Minimal plugin stub. */
export function makePlugin(
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
export function makeContext(pluginId: string): IPluginContext {
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
