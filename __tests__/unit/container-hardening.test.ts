import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => readFileSync(join(__dirname, '../..', path), 'utf8');

/** Trimmed, non-comment lines of the `app:` service, up to the `caddy:` service. */
const appService = (compose: string, source: string) => {
  const match = compose.match(/^\s*app:\n([\s\S]*?)^\s*caddy:/m);
  if (!match?.[1]) throw new Error(`app service not found in ${source}`);
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
};

/** The compose file that cloud-init writes to the server (heredoc body). */
const cloudInitCompose = (() => {
  const body = read('infra/cloud-init.yml').match(
    /<< 'COMPOSEEOF'\n([\s\S]*?)\n\s*COMPOSEEOF/,
  )?.[1];
  if (!body) throw new Error('compose heredoc not found in infra/cloud-init.yml');
  return body;
})();

const APP_SERVICES = [
  { name: 'infra/cloud-init.yml (server)', lines: appService(cloudInitCompose, 'cloud-init') },
  {
    name: 'docker/compose.yml',
    lines: appService(read('docker/compose.yml'), 'docker/compose.yml'),
  },
];

// ADR-010 runtime hardening. The server's compose, the self-host compose and CI's
// docker-smoke run must agree, or the smoke test stops catching writes that would
// fail in production (only the server sets a CPU cap: hosts differ in core count).
const HARDENING = [
  'read_only: true',
  '- /tmp:size=64m',
  '- /app/.next/cache:uid=1001,gid=1001,size=64m',
  'cap_drop: [ALL]',
  "security_opt: ['no-new-privileges:true']",
  'mem_limit: 1536m',
  'pids_limit: 256',
];

describe.each(APP_SERVICES)('$name app service', ({ lines }) => {
  it.each(HARDENING)('sets %s', (setting) => {
    expect(lines).toContain(setting);
  });

  it.each(['db', 'tts-cache', 'originals'])('bind-mounts /data/%s', (dir) => {
    expect(lines.some((line) => line.endsWith(`/${dir}:/data/${dir}`))).toBe(true);
  });
});

describe('CI docker-smoke run', () => {
  const ci = read('.github/workflows/ci.yml');

  it.each([
    '--read-only',
    '--tmpfs /tmp:size=64m',
    '--tmpfs /app/.next/cache:uid=1001,gid=1001,size=64m',
    '--cap-drop ALL',
    '--security-opt no-new-privileges:true',
  ])('boots the image with %s', (flag) => {
    expect(ci).toContain(flag);
  });
});
