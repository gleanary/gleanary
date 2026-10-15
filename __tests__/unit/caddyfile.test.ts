import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');

/** Lines without comments, so explanatory comments can name headers. */
const directives = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
    .toLowerCase();

/** The Caddyfile that cloud-init writes to the server (heredoc body). */
const cloudInitCaddyfile = (() => {
  const match = read('infra/cloud-init.yml').match(/<< 'CADDYEOF'\n([\s\S]*?)\n\s*CADDYEOF/);
  if (!match) throw new Error('Caddyfile heredoc not found in infra/cloud-init.yml');
  return match[1];
})();

const CADDYFILES = [
  { name: 'docker/Caddyfile', content: read('docker/Caddyfile'), site: '{$domain} {' },
  { name: 'infra/cloud-init.yml Caddyfile', content: cloudInitCaddyfile, site: '${domain} {' },
];

// A second CSP from the proxy would be enforced alongside the app's (browsers apply
// the intersection), blocking sources the app allows, e.g. data: images. The app
// (next.config.ts headers()) is the single owner of all security headers.
describe.each(CADDYFILES)('$name', ({ content, site }) => {
  it.each([
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Permissions-Policy',
  ])('does not set %s (owned by the app)', (header) => {
    expect(directives(content)).not.toContain(header.toLowerCase());
  });

  it('still proxies the site to the app', () => {
    expect(directives(content)).toContain(site);
    expect(directives(content)).toContain('reverse_proxy app:3000');
  });
});
