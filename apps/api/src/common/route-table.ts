import { RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';

/**
 * The application's routes, read from the same metadata Nest routes by — for
 * the checks that hold a list in the code or the docs to what is served: the
 * route inventory (docs/api/routes.md) and the activity catalogue (0046).
 */

export interface RouteEntry {
  method: string;
  /** Below the version prefix, no leading slash: `w/:workspaceId/interviews`. */
  route: string;
  controller: Type;
  handler: object;
  name: string;
}

/** Every controller reachable from `root`, following module imports. */
export function controllersOf(root: Type): Type[] {
  const seen = new Set<Type>();
  const controllers: Type[] = [];

  const visit = (module: unknown): void => {
    if (typeof module !== 'function') {
      // Dynamic modules and forward references carry controllers the walk
      // below would miss. None exist today; if one appears, the walk has to
      // learn to read it rather than quietly drop its routes.
      throw new Error('The route table only understands class modules.');
    }
    const type = module as Type;
    if (seen.has(type)) return;
    seen.add(type);
    controllers.push(...((Reflect.getMetadata('controllers', type) as Type[] | undefined) ?? []));
    for (const imported of (Reflect.getMetadata('imports', type) as unknown[] | undefined) ?? []) {
      visit(imported);
    }
  };

  visit(root);
  return controllers;
}

export function joinPath(...parts: string[]): string {
  return parts
    .flatMap((p) => p.split('/'))
    .filter(Boolean)
    .join('/');
}

export function routeTable(root: Type): RouteEntry[] {
  const routes: RouteEntry[] = [];
  for (const controller of controllersOf(root)) {
    const base = Reflect.getMetadata(PATH_METADATA, controller) as string;
    const prototype = controller.prototype as Record<string, unknown>;

    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const own = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (own === undefined || method === undefined) continue;
      routes.push({
        method: RequestMethod[method],
        route: joinPath(base, own),
        controller,
        handler,
        name,
      });
    }
  }
  return routes;
}
