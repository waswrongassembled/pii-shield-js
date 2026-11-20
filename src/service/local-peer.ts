import { readFileSync } from 'node:fs';
import { BlockList, isIPv4, isIPv6 } from 'node:net';

/**
 * Decides whether a peer address counts as this machine: 127.0.0.1 and ::1 (exactly these, as in PHP),
 * plus `peers`, a list of IPs or CIDRs (PHP's PII_LOCAL_PEERS). `gateway` stands for this container's
 * default gateway (read from /proc/net/route once): in Docker, a port published on the host's
 * 127.0.0.1 arrives from the gateway. Invalid entries are ignored.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`, how Node reports IPv4 peers on a dual-stack socket)
 * are compared as IPv4.
 */
export function localPeerMatcher(
  peers: Iterable<string> = [],
  readRouteTable: () => string = () => readFileSync('/proc/net/route', 'utf8'),
): (address: string | undefined) => boolean {
  const list = new BlockList();
  list.addAddress('127.0.0.1', 'ipv4');
  list.addAddress('::1', 'ipv6');
  for (const raw of peers) {
    let peer: string | null = raw.trim();
    if (peer === 'gateway') {
      try {
        peer = defaultGateway(readRouteTable());
      } catch {
        peer = null;
      }
    }
    if (peer !== null && peer !== '') {
      addPeer(list, peer);
    }
  }

  return (address) => {
    if (address === undefined) {
      return false;
    }
    const ip = unmapIPv4(address);
    if (isIPv4(ip)) {
      return list.check(ip, 'ipv4');
    }

    return isIPv6(ip) && list.check(ip, 'ipv6');
  };
}

/** Comma-separated list (PII_LOCAL_PEERS, PII_SERVICE_ALLOWED_HOSTS) → trimmed, non-empty entries. */
export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * The default gateway from a Linux route table (/proc/net/route: addresses as little-endian hex), or null.
 */
export function defaultGateway(routeTable: string): string | null {
  for (const line of routeTable.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    const gateway = columns[2];
    if (columns[1] === '00000000' && gateway !== undefined && /^[0-9a-fA-F]{8}$/.test(gateway)) {
      const n = Number.parseInt(gateway, 16);

      return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24].join('.');
    }
  }

  return null;
}

function addPeer(list: BlockList, peer: string): void {
  const slash = peer.indexOf('/');
  const ip = unmapIPv4(slash === -1 ? peer : peer.slice(0, slash));
  const type = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
  if (type === null) {
    return;
  }
  if (slash === -1) {
    list.addAddress(ip, type);

    return;
  }
  const bits = peer.slice(slash + 1);
  const prefix = Number(bits);
  if (!/^\d{1,3}$/.test(bits) || prefix > (type === 'ipv4' ? 32 : 128)) {
    return;
  }
  list.addSubnet(ip, prefix, type);
}

function unmapIPv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);

  return mapped?.[1] ?? address;
}
