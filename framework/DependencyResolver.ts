import type {
  IDependencyRequirement,
  IPluginManifest,
  IValidationResult,
} from './interfaces.js';

// ─────────────────────────────────────────────────────────────
// DependencyResolver — topological sort & validation
// ─────────────────────────────────────────────────────────────

/**
 * Resolves plugin boot order by building a dependency graph and
 * performing a topological sort (Kahn's algorithm).
 *
 * Also validates the graph for:
 * - **Missing dependencies** — a plugin requires an ID not present
 *   in the provided manifest set.
 * - **Circular dependencies** — two or more plugins form a cycle,
 *   making a valid boot order impossible.
 */
export class DependencyResolver {
  /**
   * Validate the dependency graph without producing an ordering.
   *
   * Returns errors for missing and circular dependencies, plus
   * warnings for host-dependency entries (which are skipped during
   * resolution since the host is always available).
   */
  validate(manifests: readonly IPluginManifest[]): IValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const ids = new Set(manifests.map((m) => m.id));

    for (const manifest of manifests) {
      for (const dep of manifest.dependencies ?? []) {
        if (dep.id === 'host') {
          warnings.push(
            `Plugin "${manifest.id}" declares a dependency on "host" — ` +
              `this is informational and skipped during resolution.`,
          );
          continue;
        }
        if (!ids.has(dep.id)) {
          errors.push(
            `Plugin "${manifest.id}" requires missing plugin "${dep.id}" (${dep.version}).`,
          );
        }
      }
    }

    // Check for cycles even when there are missing deps, so the
    // caller gets the full picture in one pass.
    const cycleErrors = this.#detectCycles(manifests, ids);
    errors.push(...cycleErrors);

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Return an ordered list of plugin IDs such that every plugin
   * appears **after** all of its dependencies.
   *
   * @throws {Error} If the graph contains cycles or missing deps.
   */
  resolve(manifests: readonly IPluginManifest[]): string[] {
    const validation = this.validate(manifests);
    if (!validation.valid) {
      throw new Error(
        `DependencyResolver: cannot resolve — ${validation.errors.join('; ')}`,
      );
    }

    return this.#topologicalSort(manifests);
  }

  // ── Kahn's algorithm ────────────────────────────────────

  #topologicalSort(manifests: readonly IPluginManifest[]): string[] {
    const ids = new Set(manifests.map((m) => m.id));

    // Build adjacency list and in-degree map.
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const id of ids) {
      inDegree.set(id, 0);
      dependents.set(id, []);
    }

    for (const manifest of manifests) {
      for (const dep of this.#pluginDeps(manifest)) {
        if (!ids.has(dep.id)) continue;
        // dep.id → manifest.id  (manifest depends on dep)
        dependents.get(dep.id)!.push(manifest.id);
        inDegree.set(manifest.id, (inDegree.get(manifest.id) ?? 0) + 1);
      }
    }

    // Seed the queue with nodes that have no dependencies.
    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
      if (degree === 0) queue.push(id);
    }
    // Stable ordering within the same topological level.
    queue.sort();

    const sorted: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      sorted.push(current);

      for (const dependent of dependents.get(current) ?? []) {
        const newDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, newDegree);
        if (newDegree === 0) {
          // Insert in sorted position for deterministic output.
          const insertIdx = queue.findIndex((q) => q > dependent);
          if (insertIdx === -1) queue.push(dependent);
          else queue.splice(insertIdx, 0, dependent);
        }
      }
    }

    // Any remaining nodes are part of a cycle (should not happen
    // if validate() passed, but guard defensively).
    if (sorted.length !== ids.size) {
      throw new Error('DependencyResolver: cycle detected during sort.');
    }

    return sorted;
  }

  // ── Cycle detection via DFS colouring ───────────────────

  #detectCycles(
    manifests: readonly IPluginManifest[],
    ids: ReadonlySet<string>,
  ): string[] {
    const White = 0, Grey = 1, Black = 2;

    const colors = new Map<string, number>();
    for (const id of ids) colors.set(id, White);

    const adjList = new Map<string, string[]>();
    for (const m of manifests) {
      adjList.set(
        m.id,
        this.#pluginDeps(m)
          .filter((d) => ids.has(d.id))
          .map((d) => d.id),
      );
    }

    const cycles: string[][] = [];

    const dfs = (node: string, path: string[]): void => {
      colors.set(node, Grey);
      path.push(node);

      for (const neighbour of adjList.get(node) ?? []) {
        const c = colors.get(neighbour);
        if (c === Grey) {
          // Back-edge → cycle found.
          const cycleStart = path.indexOf(neighbour);
          cycles.push(path.slice(cycleStart).concat(neighbour));
        } else if (c === White) {
          dfs(neighbour, path);
        }
      }

      path.pop();
      colors.set(node, Black);
    };

    for (const id of ids) {
      if (colors.get(id) === White) {
        dfs(id, []);
      }
    }

    return cycles.map(
      (cycle) =>
        `Circular dependency detected: ${cycle.join(' → ')}.`,
    );
  }

  // ── helpers ─────────────────────────────────────────────

  /** Filter out the special "host" dependency. */
  #pluginDeps(manifest: IPluginManifest): readonly IDependencyRequirement[] {
    return (manifest.dependencies ?? []).filter((d) => d.id !== 'host');
  }
}
