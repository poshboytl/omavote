// Origins and Chrome match patterns. Sites are keyed by origin (scheme, host, port);
// host permissions and content-script registrations are per host, any port.

function parse(origin: string): URL | null {
  try {
    const u = new URL(origin);
    return u.origin === origin ? u : null;
  } catch {
    return null;
  }
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/** https sites, plus plain http on the local development addresses. */
export function acceptableOrigin(origin: string): boolean {
  const u = parse(origin);
  if (!u) return false;
  return u.protocol === "https:" || (u.protocol === "http:" && isLocalHost(u.hostname));
}

/** Host-level match pattern for an origin: `https://vote.example/*` (any port). */
export function originPattern(origin: string): string {
  const u = parse(origin);
  if (!u) throw new Error(`not an origin: ${origin}`);
  return `${u.protocol}//${u.hostname}/*`;
}

/** Whether `origin` falls under a `scheme://host/*` pattern (ports are not compared). */
export function matchesPattern(origin: string, pattern: string): boolean {
  const u = parse(origin);
  const m = /^(https?):\/\/([^/:]+)\/\*$/.exec(pattern);
  if (!u || !m) return false;
  return u.protocol === `${m[1]}:` && u.hostname === m[2];
}

/**
 * A single-host grant (`https://vote.example/*`, or a local development address).
 * Wildcard grants from Chrome's site-access menu ("on all sites") are not used.
 */
export function isSingleHostPattern(pattern: string): boolean {
  return /^https:\/\/[a-z0-9.-]+\/\*$/.test(pattern) || /^http:\/\/(localhost|127\.0\.0\.1)\/\*$/.test(pattern);
}

export function isOfficial(origin: string, officialPatterns: readonly string[]): boolean {
  return officialPatterns.some((p) => matchesPattern(origin, p));
}
