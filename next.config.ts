import type { NextConfig } from 'next';

// Next dev requires 'unsafe-eval'/'unsafe-inline' for HMR and its inline runtime. In
// production we still need 'unsafe-inline': the Next.js App Router hydrates every page
// via its own dynamic inline scripts (`self.__next_f.push(...)`), whose bodies vary per
// page and cannot be hash-allowlisted. Per the CSP spec, adding ANY hash or nonce to
// script-src makes the browser IGNORE 'unsafe-inline', so hashing our two hand-written
// bootstrap scripts (theme FOUC guard, SW registration) would silently block hydration
// on every route. A nonce-based CSP is tracked follow-up debt.
//
// The app is the single owner of all security headers: docker/Caddyfile only
// terminates TLS and proxies. A second CSP from the proxy would be enforced
// alongside this one (browsers apply the intersection) and block what we allow here.
const scriptSrc =
  process.env.NODE_ENV === 'production'
    ? `script-src 'self' 'unsafe-inline'`
    : `script-src 'self' 'unsafe-eval' 'unsafe-inline'`;

// Baseline Content-Security-Policy — see docs/architecture.md §16.2.
const contentSecurityPolicy = [
  `default-src 'self'`,
  scriptSrc,
  `style-src 'self' 'unsafe-inline'`, // KaTeX inline styles + Tailwind
  `img-src 'self' https: data:`,
  `connect-src 'self'`,
  `worker-src 'self' blob:`, // pdfjs worker
  `object-src 'none'`,
  `frame-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
].join('; ');

/** Security response headers applied to every route. */
export async function headers() {
  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
  ];
}

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: [
    'better-sqlite3',
    'pino',
    'pino-pretty',
    'pdfjs-dist',
    '@anthropic-ai/sdk',
  ],
  headers,
};

export default nextConfig;
