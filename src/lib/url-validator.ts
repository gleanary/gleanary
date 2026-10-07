import { URL } from 'url';
import net from 'net';
import dns from 'dns/promises';
import { ValidationError } from '@/lib/errors';

const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];

// Private/loopback/link-local ranges checked numerically — immune to
// serialization differences (e.g. `::ffff:10.0.0.1` vs `::ffff:a00:1`),
// including IPv4-mapped IPv6 addresses, which BlockList checks against
// the IPv4 rules natively.
const PRIVATE_RANGES = new net.BlockList();
PRIVATE_RANGES.addSubnet('0.0.0.0', 8, 'ipv4'); // "this network" — routes to localhost on Linux
PRIVATE_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_RANGES.addAddress('::', 'ipv6');
PRIVATE_RANGES.addAddress('::1', 'ipv6');
PRIVATE_RANGES.addSubnet('fc00::', 7, 'ipv6'); // unique-local
PRIVATE_RANGES.addSubnet('fe80::', 10, 'ipv6'); // link-local

/**
 * Checks whether a string is an IP address in a private/loopback/link-local range.
 * Non-IP strings (hostnames) return false.
 * @param addr - Bare IPv4 or IPv6 address (e.g. "10.0.0.1", "fd00::1")
 * @returns true if the address is private
 */
function isPrivateAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 0) return false;
  return PRIVATE_RANGES.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Validates a hostname against SSRF attack vectors.
 * Blocks known local addresses, private IPv4/IPv6 literals, and hostnames
 * whose A or AAAA records resolve to private ranges.
 * @param hostname - The hostname to validate (e.g. "imap.gmail.com", "[fd00::1]")
 * @returns Resolves when the hostname is safe to fetch
 * @throws ValidationError if the hostname is internal or resolves to a private network
 */
export async function validateHostname(hostname: string): Promise<void> {
  // Normalize once so every downstream check sees one bare form: URL.hostname
  // wraps IPv6 literals in brackets, and a trailing dot (FQDN root anchor)
  // hides an IP literal from net.isIP (e.g. "10.0.0.1.").
  let bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bare.endsWith('.')) bare = bare.slice(0, -1);

  if (BLOCKED_HOSTS.includes(bare)) {
    throw new ValidationError('Internal URLs are not allowed');
  }
  // Block literal private IP addresses directly (no DNS needed).
  if (isPrivateAddress(bare)) {
    throw new ValidationError('URL resolves to private network');
  }
  const [v4Addresses, v6Addresses] = await Promise.all([
    dns.resolve4(hostname).catch(() => [] as string[]),
    dns.resolve6(hostname).catch(() => [] as string[]),
  ]);
  if (v4Addresses.some(isPrivateAddress) || v6Addresses.some(isPrivateAddress)) {
    throw new ValidationError('URL resolves to private network');
  }
}

/**
 * Validates a URL for server-side fetching, blocking private/internal addresses (SSRF prevention).
 * @param urlString - The URL to validate
 * @returns Parsed URL object if valid
 * @throws ValidationError if the URL is invalid or resolves to a private network
 */
export async function validateUrl(urlString: string): Promise<URL> {
  const url = new URL(urlString);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ValidationError('Only HTTP/HTTPS URLs are allowed');
  }

  await validateHostname(url.hostname);

  return url;
}
