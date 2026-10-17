/**
 * Short-lived tablet share links for one PDF.
 * Minted on loopback; the public GET is the only /scholar exception that
 * accepts LAN clients — the unguessable token is the access control.
 */
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';

const TTL_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIVE = 48;

export interface TabletShareRecord {
  token: string;
  paperId: string;
  absPath: string;
  title: string;
  expiresAt: number;
}

const shares = new Map<string, TabletShareRecord>();

function prune(): void {
  const now = Date.now();
  for (const [token, rec] of shares) {
    if (rec.expiresAt <= now) shares.delete(token);
  }
  if (shares.size <= MAX_ACTIVE) return;
  const ordered = [...shares.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  for (const rec of ordered.slice(0, shares.size - MAX_ACTIVE)) {
    shares.delete(rec.token);
  }
}

/** Non-internal IPv4 addresses of this machine (LAN reachability). */
export function lanIPv4Addresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((iface): iface is NonNullable<typeof iface> => {
      return iface !== undefined && iface.family === 'IPv4' && !iface.internal;
    })
    .map((iface) => iface.address);
}

/**
 * Absolute http origins a tablet on the same LAN can use.
 * @param port - webServer listen port
 * @param bindHost - webServer bind host (0.0.0.0 / 127.0.0.1 / …)
 */
export function tabletShareBases(port: number, bindHost: string): string[] {
  if (bindHost === '127.0.0.1' || bindHost === '::1' || bindHost === 'localhost') {
    return [];
  }
  if (bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '') {
    return lanIPv4Addresses().map((ip) => `http://${ip}:${port}`);
  }
  // Explicit LAN bind
  if (/^\d+\.\d+\.\d+\.\d+$/.test(bindHost)) {
    return [`http://${bindHost}:${port}`];
  }
  return lanIPv4Addresses().map((ip) => `http://${ip}:${port}`);
}

/**
 * Mint a share token for one on-disk PDF.
 * @returns the share record plus absolute URLs for each LAN base
 */
export function mintTabletShare(input: {
  paperId: string;
  absPath: string;
  title: string;
  bases: string[];
}): { token: string; expiresAt: number; urls: string[]; primaryUrl: string | null } {
  prune();
  const token = randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TTL_MS;
  shares.set(token, {
    token,
    paperId: input.paperId,
    absPath: input.absPath,
    title: input.title,
    expiresAt,
  });
  const path = `/scholar/tablet-share/${token}`;
  const urls = input.bases.map((base) => `${base.replace(/\/$/, '')}${path}`);
  return { token, expiresAt, urls, primaryUrl: urls[0] ?? null };
}

/** Resolve a live share by token (or null if missing/expired). */
export function getTabletShare(token: string): TabletShareRecord | null {
  prune();
  const rec = shares.get(token);
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) {
    shares.delete(token);
    return null;
  }
  return rec;
}

/**
 * Render a QR SVG for a share URL (uses optional `qrcode` if resolvable).
 * @returns SVG string or null when the encoder is unavailable
 */
export async function tabletShareQrSvg(url: string): Promise<string | null> {
  try {
    const mod = await import('qrcode') as {
      default?: { toString: (text: string, opts: object) => Promise<string> };
      toString?: (text: string, opts: object) => Promise<string>;
    };
    const toString = mod.toString ?? mod.default?.toString;
    if (!toString) return null;
    return await toString(url, {
      type: 'svg',
      margin: 1,
      width: 200,
      errorCorrectionLevel: 'M',
    });
  } catch {
    return null;
  }
}
