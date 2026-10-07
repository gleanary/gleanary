import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dns.resolve4/resolve6 to control SSRF validation without real DNS lookups
vi.mock('dns/promises', () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

import dns from 'dns/promises';
import { validateUrl, validateHostname } from '@/lib/url-validator';

const mockResolve4 = vi.mocked(dns.resolve4);
const mockResolve6 = vi.mocked(dns.resolve6);

describe('validateUrl', () => {
  beforeEach(() => {
    mockResolve4.mockResolvedValue(['93.184.216.34']); // public IP
    mockResolve6.mockResolvedValue([]); // no AAAA records by default
  });

  it('accepts a valid HTTPS URL', async () => {
    const url = await validateUrl('https://example.com/page');
    expect(url.hostname).toBe('example.com');
    expect(url.protocol).toBe('https:');
  });

  it('accepts a valid HTTP URL', async () => {
    const url = await validateUrl('http://example.com/page');
    expect(url.protocol).toBe('http:');
  });

  it('rejects non-HTTP protocols', async () => {
    await expect(validateUrl('ftp://example.com')).rejects.toThrow(
      'Only HTTP/HTTPS URLs are allowed',
    );
  });

  it('rejects file:// protocol', async () => {
    await expect(validateUrl('file:///etc/passwd')).rejects.toThrow(
      'Only HTTP/HTTPS URLs are allowed',
    );
  });

  it('rejects javascript: protocol', async () => {
    await expect(validateUrl('javascript:alert(1)')).rejects.toThrow();
  });

  it('rejects localhost', async () => {
    await expect(validateUrl('http://localhost/admin')).rejects.toThrow(
      'Internal URLs are not allowed',
    );
  });

  it('rejects 127.0.0.1', async () => {
    await expect(validateUrl('http://127.0.0.1:8080')).rejects.toThrow(
      'Internal URLs are not allowed',
    );
  });

  it('rejects 0.0.0.0', async () => {
    await expect(validateUrl('http://0.0.0.0')).rejects.toThrow('Internal URLs are not allowed');
  });

  it('rejects [::1] IPv6 loopback address', async () => {
    await expect(validateUrl('http://[::1]')).rejects.toThrow('Internal URLs are not allowed');
  });

  it('rejects URLs resolving to 10.x.x.x private range', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.1']);
    await expect(validateUrl('https://internal.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to 172.16-31.x.x private range', async () => {
    mockResolve4.mockResolvedValue(['172.16.0.1']);
    await expect(validateUrl('https://internal.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to 192.168.x.x private range', async () => {
    mockResolve4.mockResolvedValue(['192.168.1.100']);
    await expect(validateUrl('https://internal.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to 169.254.x.x link-local range', async () => {
    mockResolve4.mockResolvedValue(['169.254.169.254']);
    await expect(validateUrl('https://metadata.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects 0.0.0.1 (0.0.0.0/8 "this network", routes to localhost on Linux)', async () => {
    await expect(validateUrl('http://0.0.0.1')).rejects.toThrow('URL resolves to private network');
  });

  // validateHostname takes a raw host string (e.g. IMAP host field) that skips
  // WHATWG URL normalization, so a trailing-dot literal reaches it verbatim.
  it('rejects a raw private IPv4 literal with a trailing FQDN dot', async () => {
    await expect(validateHostname('10.0.0.1.')).rejects.toThrow('URL resolves to private network');
  });

  it('rejects 127.0.0.2 loopback-range literal', async () => {
    await expect(validateUrl('http://127.0.0.2')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to 127.x.x.x loopback range', async () => {
    mockResolve4.mockResolvedValue(['127.0.0.1']);
    await expect(validateUrl('https://rebind.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects [fd00::1] IPv6 unique-local literal', async () => {
    await expect(validateUrl('http://[fd00::1]')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects [fc00::1] IPv6 unique-local literal', async () => {
    await expect(validateUrl('http://[fc00::1]')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects [fe80::1] IPv6 link-local literal', async () => {
    await expect(validateUrl('http://[fe80::1]')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects [::ffff:192.168.1.1] IPv4-mapped IPv6 literal', async () => {
    await expect(validateUrl('http://[::ffff:192.168.1.1]')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects [::ffff:127.0.0.1] IPv4-mapped loopback literal', async () => {
    await expect(validateUrl('http://[::ffff:127.0.0.1]')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving only to a private AAAA record', async () => {
    mockResolve4.mockRejectedValue(new Error('ENODATA'));
    mockResolve6.mockResolvedValue(['fd00::1']);
    await expect(validateUrl('https://v6-internal.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to IPv6 loopback ::1 via AAAA', async () => {
    mockResolve6.mockResolvedValue(['::1']);
    await expect(validateUrl('https://rebind6.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to a link-local AAAA record', async () => {
    mockResolve6.mockResolvedValue(['fe80::abcd']);
    await expect(validateUrl('https://linklocal.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects URLs resolving to an IPv4-mapped private AAAA record', async () => {
    mockResolve6.mockResolvedValue(['::ffff:10.0.0.1']);
    await expect(validateUrl('https://mapped.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('accepts URLs resolving to a public AAAA record', async () => {
    mockResolve6.mockResolvedValue(['2606:4700::6810:84e5']);
    const url = await validateUrl('https://v6-public.example.com');
    expect(url.hostname).toBe('v6-public.example.com');
  });

  it('allows URLs when DNS resolution fails (no addresses)', async () => {
    mockResolve4.mockRejectedValue(new Error('ENOTFOUND'));
    mockResolve6.mockRejectedValue(new Error('ENOTFOUND'));
    const url = await validateUrl('https://nonexistent-but-valid.com');
    expect(url.hostname).toBe('nonexistent-but-valid.com');
  });

  it('rejects if any resolved address is private', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34', '10.0.0.1']);
    await expect(validateUrl('https://dual-homed.example.com')).rejects.toThrow(
      'URL resolves to private network',
    );
  });

  it('rejects malformed URLs', async () => {
    await expect(validateUrl('not-a-url')).rejects.toThrow();
  });
});
