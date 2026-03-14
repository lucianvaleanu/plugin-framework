# Pluh

A TypeScript-native, runtime-agnostic plugin framework that provides a structured lifecycle, dependency injection, event-driven communication, and declarative plugin discovery — all without requiring a build step.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Creating a Plugin](#creating-a-plugin)
- [Framework Components](#framework-components)
  - [Plugin Lifecycle](#plugin-lifecycle)
  - [Plugin Context (Host API)](#plugin-context-host-api)
  - [Event Bus](#event-bus)
  - [Service Registry](#service-registry)
  - [Dependency Resolver](#dependency-resolver)
  - [Manifest Loader](#manifest-loader)
- [Directory Structure](#directory-structure)
- [Running Tests](#running-tests)

---

## Overview

This framework lets you build modular applications where features are packaged as **plugins** — self-contained units that declare their identity, dependencies, and capabilities through a JSON manifest. The host application discovers, validates, and manages these plugins through a well-defined lifecycle without ever tightly coupling to them.

**Key principles:**

- **Inversion of Control** — plugins receive everything they need via a context object; they never reach out to globals.
- **Error containment** — a failing plugin cannot crash the host or prevent other plugins from loading.
- **Dependency ordering** — the framework automatically determines the correct boot sequence using topological sorting.
- **Declarative discovery** — the host understands a plugin's identity and requirements by reading its manifest, without executing any code.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      PluginHost                         │
│  (top-level orchestrator — wires everything together)   │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  EventBus    │  │  Service     │  │  Plugin      │  │
│  │              │  │  Registry    │  │  Registry    │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                 │                 │           │
│  ┌──────┴─────────────────┴─────────────────┴───────┐  │
│  │              PluginManager                        │  │
│  │  (lifecycle state machine, error containment)     │  │
│  └──────┬────────────────────────────────┬───────────┘  │
│         │                                │              │
│  ┌──────┴───────────┐  ┌────────────────┴───────────┐  │
│  │ ManifestLoader   │  │  DependencyResolver        │  │
│  │ (scan + validate)│  │  (topological sort)        │  │
│  └──────────────────┘  └────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────┐
│  Plugin A            │◄── receives PluginContext
│  Plugin B            │    (scoped logger, storage,
│  Plugin C            │     event bus, services)
└─────────────────────┘
```

## Getting Started

### Prerequisites

- **Node.js** ≥ 22 (uses native TypeScript execution)
- **npm** (or your preferred package manager)

### Install

```bash
npm install
```

### Quick start

```typescript
import { PluginHost } from './framework/PluginHost.js';

const host = new PluginHost({ pluginDir: './plugins' });

await host.start();   // discover → validate → install → activate
// ... application runs ...
await host.stop();    // graceful reverse-order shutdown
```

## Creating a Plugin

### 1. Create a directory under `plugins/`

```
plugins/
  my-plugin/
    plugin.json
    index.ts
```

### 2. Write the manifest (`plugin.json`)

Every plugin must ship a `plugin.json` file that describes its identity, dependencies, and capabilities. The framework validates this against a strict schema before loading any code.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "Does something useful",
  "author": {
    "name": "Your Name",
    "email": "you@example.com"
  },
  "dependencies": [
    { "id": "other-plugin", "version": "^1.0.0" }
  ],
  "capabilities": ["render", "export"],
  "permissions": ["network"],
  "tags": ["utility"],
  "entryPoint": "index.ts"
}
```

**Required fields:** `id`, `name`, `version`, `description`, `author` (with `name`).

**Optional fields:** `dependencies`, `capabilities`, `runtime`, `permissions`, `priority`, `tags`, `entryPoint`, `descriptionForModel`.

### 3. Implement the plugin (`index.ts`)

```typescript
import type {
  IPlugin,
  IPluginContext,
  IPluginManifest,
  IHostContext,
  IPluginLifecycleHooks,
} from '../../framework/interfaces.js';
import { PluginLifecycleState } from '../../framework/interfaces.js';

export default function createPlugin(manifest: IPluginManifest): IPlugin & IPluginLifecycleHooks {
  let context: IPluginContext;

  return {
    manifest,
    state: PluginLifecycleState.Discovered,
    isEnabled: true,
    isReady: false,

    // Called by the framework during installation.
    // The context provides scoped logger, storage, event bus, and services.
    async initialize(ctx: IPluginContext) {
      context = ctx;
      ctx.logger.info('Initializing...');

      // Register a service that other plugins can consume
      ctx.host.services.register({
        id: 'my-plugin.greeter',
        scope: 'root',
        factory: () => ({ greet: (name: string) => `Hello, ${name}!` }),
      });
    },

    async execute<TInput, TOutput>(input: TInput, ctx?: IHostContext): Promise<TOutput> {
      context.logger.info('Executing with input:', input);
      return { success: true } as TOutput;
    },

    async configure(settings: Record<string, unknown>) {
      context.logger.info('Configured with:', settings);
    },

    canHandle(inputType: string) {
      return inputType === 'greeting';
    },

    async shutdown() {
      context.logger.info('Shutting down...');
    },

    // Optional lifecycle hooks
    async onInstall() {
      // One-time setup (e.g., database migrations)
    },

    async onActivate() {
      // Subscribe to events, start background tasks
      context.host.events.on('order.placed', async (event) => {
        context.logger.info('Order received:', event.payload);
      });
    },

    async onDeactivate() {
      // Clean up subscriptions, stop timers
    },

    async onUninstall() {
      // Remove persistent data
    },
  };
}
```

## Framework Components

### Plugin Lifecycle

The `PluginManager` enforces a strict state machine that every plugin transitions through:

```
Discovered → Installed → Activated → Mounted
                                        │
Uninstalled ← Deactivated ◄────────────┘
                   │
                   └──► Activated  (re-activation)

Any state ──► Error ──► Uninstalled
```

| State | Description |
|-------|-------------|
| **Discovered** | Manifest scanned; no code executed yet |
| **Installed** | `onInstall()` + `initialize(context)` completed |
| **Activated** | `onActivate()` completed; plugin is running |
| **Mounted** | Primary UI/logic rendered (optional) |
| **Deactivated** | `onDeactivate()` + `shutdown()` completed |
| **Uninstalled** | `onUninstall()` completed; fully removed |
| **Error** | An unrecoverable failure occurred |

**Error containment:** Every lifecycle transition is wrapped in a try-catch boundary. If plugin A fails during activation, plugin B still gets its turn.

### Plugin Context (Host API)

When a plugin is installed, it receives an `IPluginContext` — a scoped bridge to the host:

```typescript
interface IPluginContext {
  host: IHostAPI;                    // Full host API surface
  manifest: Readonly<IPluginManifest>; // Plugin's own metadata (frozen)
  logger: ILogger;                   // Pre-scoped: [my-plugin] message
  storage: IStorage;                 // Namespaced: plugin:my-plugin:key
}
```

- **Scoped logger** — every log message is automatically prefixed with `[pluginId]` for easy attribution.
- **Namespaced storage** — keys are transparently prefixed with `plugin:{id}:` so plugins can't accidentally overwrite each other's data.
- **Frozen manifest** — the plugin can read its own metadata but cannot mutate it.

### Event Bus

A lightweight, in-process pub/sub system for decoupled inter-plugin communication:

```typescript
// Subscribe
const sub = context.host.events.on('order.placed', async (event) => {
  console.log(event.payload);
});

// Emit
await context.host.events.emit({
  id: crypto.randomUUID(),
  type: 'order.placed',
  category: EventCategory.Domain,
  timestamp: Date.now(),
  source: 'my-plugin',
  deliveryStrategy: EventDeliveryStrategy.StateTransfer,
  payload: { orderId: '123', total: 99.99 },
});

// Unsubscribe
sub.unsubscribe();
```

- Handlers run sequentially in registration order.
- A failing handler does not prevent subsequent handlers from executing.
- Supports wildcard subscriptions via `"*"`.
- Supports `once()` for one-shot subscriptions.

### Service Registry

Dependency injection container with three lifetime scopes:

| Scope | Behaviour |
|-------|-----------|
| `Root` | Single shared instance (singletons) |
| `Plugin` | One instance per consuming plugin |
| `Transient` | Fresh instance on every resolution |

```typescript
// Register a service
context.host.services.register({
  id: 'core.database',
  scope: ServiceScope.Root,
  factory: (ctx) => new DatabaseConnection(ctx),
  version: '1.0.0',
  provider: 'my-plugin',
});

// Resolve a service
const db = await context.host.services.resolve<DatabaseConnection>('core.database');
```

### Dependency Resolver

Automatically determines the correct boot order using **topological sorting** (Kahn's algorithm):

```json
// plugin-a/plugin.json
{ "id": "app", "dependencies": [{ "id": "db", "version": "^1.0.0" }] }

// plugin-b/plugin.json  
{ "id": "db" }
```

The resolver ensures `db` is fully installed and activated before `app` starts.

**Validation checks:**
- **Missing dependencies** — a plugin requires an ID not present in the discovered set.
- **Circular dependencies** — two or more plugins form a cycle (e.g., A → B → C → A).
- **Host dependencies** — `"host"` is a special ID that is always available and skipped during resolution.

### Manifest Loader

Scans a plugin directory for sub-directories containing `plugin.json` files:

```
plugins/
  auth-plugin/
    plugin.json    ← discovered and validated
    index.ts
  dashboard/
    plugin.json    ← discovered and validated
    index.ts
  random-folder/
    readme.md      ← skipped (no plugin.json)
```

**Schema validation** catches configuration errors early:
- Required fields: `id`, `name`, `version`, `description`, `author.name`
- Type checking for all fields (strings, arrays, nested objects)
- SemVer format warning for the `version` field
- Dependency items validated for `id` + `version` presence

Invalid manifests are reported as errors but do not prevent other plugins from loading.

## Directory Structure

```
plugin-framework/
├── framework/                    # Core framework source
│   ├── interfaces.ts             # All type definitions and contracts
│   ├── PluginHost.ts             # Top-level orchestrator
│   ├── PluginManager.ts          # Lifecycle state machine
│   ├── PluginRegistry.ts         # In-memory plugin directory
│   ├── PluginContext.ts           # Scoped context factory
│   ├── EventBus.ts               # Pub/sub event system
│   ├── ServiceRegistry.ts        # DI container
│   ├── DependencyResolver.ts     # Topological sort + validation
│   └── ManifestLoader.ts         # Directory scanner + JSON schema
├── host-app/                     # Example host application
│   └── index.ts
├── plugins/                      # Plugin directory (scanned at startup)
├── tests/                        # Test suite
│   ├── helpers.ts                # Shared test utilities
│   ├── PluginRegistry.test.ts
│   ├── ServiceRegistry.test.ts
│   ├── PluginManager.test.ts
│   ├── PluginContext.test.ts
│   ├── DependencyResolver.test.ts
│   └── ManifestLoader.test.ts
├── package.json
└── tsconfig.json
```

## Running Tests

```bash
npm test
```

This runs all `*.test.ts` files via Node's built-in test runner with [`tsx`](https://github.com/privatenumber/tsx) for TypeScript support:

```bash
node --import tsx --test
```