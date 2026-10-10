import { join } from 'node:path';
import type { NextConfig } from 'next';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Traced from the repository root so the workspace packages come along.
  outputFileTracingRoot: join(process.cwd(), '../..'),
  transpilePackages: ['@milyonuse/ui', '@milyonuse/contracts'],

  /**
   * Development only. Sign in at 127.0.0.1 — the API sets its cookie there —
   * and `next dev` treats every host but localhost as cross-origin, refusing
   * its HMR connection: the page then renders and never hydrates.
   */
  allowedDevOrigins: ['127.0.0.1'],

  /**
   * The API is served from this origin rather than its own.
   *
   * Session cookies are the reason. A separate API origin would make every
   * authenticated request cross-site, which means SameSite=None, which means
   * the cookie rides along on requests this application did not make.
   * Proxying keeps one origin, so SameSite=Lax holds and CSRF has no purchase.
   */
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
};

export default config;
