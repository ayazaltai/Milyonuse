/**
 * Where the API's routes are mounted.
 *
 * Shared by the server (app.factory.ts), the tests that assemble the application
 * themselves, and the route inventory (docs/api/routes.md), so none of them
 * can describe a different API from the one that is served.
 */
export const API_PREFIX = 'api/v1';

/**
 * Probes stay at the root so infrastructure does not have to track the API
 * version to know whether the process is healthy.
 */
export const UNPREFIXED_ROUTES = ['health/live', 'health/ready'];
