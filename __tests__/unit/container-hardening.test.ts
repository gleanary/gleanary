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

/** Body of a `cat > … << 'TAG'` heredoc: a file cloud-init writes to the server. */
const cloudInitHeredoc = (tag: string) => {
  const body = read('infra/cloud-init.yml').match(
    new RegExp(`<< '${tag}'\\n([\\s\\S]*?)\\n\\s*${tag}`),
  )?.[1];
  if (!body) throw new Error(`${tag} heredoc not found in infra/cloud-init.yml`);
  return body;
};

const cloudInitCompose = cloudInitHeredoc('COMPOSEEOF');

const APP_SERVICES = [
  { name: 'infra/cloud-init.yml (server)', lines: appService(cloudInitCompose, 'cloud-init') },
  {
    name: 'docker/compose.yml',
    lines: appService(read('docker/compose.yml'), 'docker/compose.yml'),
  },
];

// ADR-010 runtime hardening. The server's compose, the self-host compose and CI's
// docker-smoke run must agree, or the smoke test stops catching writes that would
// fail in production. No CPU cap: `cpus` above the host's core count stops the
// container from starting, and on a 1-vCPU server it limits nothing.
const HARDENING = [
  'read_only: true',
  '- /tmp:size=64m',
  '- /app/.next/cache:uid=1001,gid=1001,size=64m',
  'cap_drop: [ALL]',
  "security_opt: ['no-new-privileges:true']",
  'mem_limit: 1536m',
  'pids_limit: 256',
];

const FORBIDDEN = ['cpus:'];

describe.each(APP_SERVICES)('$name app service', ({ lines }) => {
  it.each(HARDENING)('sets %s', (setting) => {
    expect(lines).toContain(setting);
  });

  it.each(FORBIDDEN)('does not set %s', (key) => {
    expect(lines.some((line) => line.startsWith(key))).toBe(false);
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

describe('cloud-init egress firewall', () => {
  const cloudInit = read('infra/cloud-init.yml');
  const script = cloudInitHeredoc('EGRESSEOF');

  it('only lets containers open DNS, HTTP(S) and IMAPS connections', () => {
    expect(script).toContain('TCP_PORTS=53,80,443,993');
    expect(script).toContain('-p udp --dport 53 -j RETURN');
    const catchAll = script.indexOf('-A GLEANARY-EGRESS -j REJECT');
    expect(catchAll).toBeGreaterThan(script.indexOf('--dports'));
  });

  it('rejects private ranges and the cloud metadata address', () => {
    for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']) {
      expect(script).toContain(range);
    }
  });

  it('is installed as a unit re-applied whenever Docker starts', () => {
    expect(cloudInit).toContain('WantedBy=docker.service');
    expect(cloudInit).toContain('systemctl enable --now gleanary-egress');
  });

  it('leaves no ${ for templatefile to interpolate', () => {
    expect(script).not.toContain('${');
  });
});
