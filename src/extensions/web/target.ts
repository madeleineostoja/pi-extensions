import ipaddr from "ipaddr.js";
import { LIMITS } from "./constants.js";
import { WebError } from "./errors.js";

export type PublicTarget = {
  url: string;
  hostname: string;
  isLiteral: boolean;
};

export function canonicalTarget(input: string | URL): PublicTarget {
  const raw = typeof input === "string" ? input.trim() : input.href;
  if (Array.from(raw).length > LIMITS.urlChars) {
    throw new WebError(
      "target",
      "Web Fetch URL exceeds its 2,000-character limit.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WebError(
      "target",
      "Web Fetch requires one valid absolute HTTP(S) URL.",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebError("target", "Web Fetch permits only HTTP and HTTPS URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new WebError("target", "Web Fetch does not permit URL credentials.");
  }
  const hostname = canonicalHostname(parsed.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new WebError(
      "target",
      "Web Fetch does not permit localhost targets.",
    );
  }
  const literal = parseAddress(hostname);
  if (literal && !isPublicAddress(hostname)) {
    throw new WebError(
      "target",
      "Web Fetch permits only public unicast addresses.",
    );
  }
  const host = literal?.kind() === "ipv6" ? `[${hostname}]` : hostname;
  return {
    url: `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}${parsed.pathname}${parsed.search}`,
    hostname,
    isLiteral: Boolean(literal),
  };
}

export function canonicalHostname(value: string): string {
  const unwrapped =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const hostname = unwrapped.toLowerCase().replace(/\.+$/u, "");
  if (!hostname || hostname.includes("%") || /[\s/\\@]/u.test(hostname)) {
    throw new WebError("target", "Web Fetch URL hostname is malformed.");
  }
  return hostname;
}

export function isPublicAddress(value: string): boolean {
  const address = parseAddress(value);
  if (!address || address.range() !== "unicast") {
    return false;
  }
  if (
    address.kind() === "ipv6" &&
    (address as ipaddr.IPv6).isIPv4MappedAddress()
  ) {
    return false;
  }
  return true;
}

function parseAddress(value: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  try {
    return ipaddr.isValid(value) ? ipaddr.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
