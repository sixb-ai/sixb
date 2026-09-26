import { BlockList, isIP, isIPv4 } from "node:net"

/** Loopback, private, and link-local networks: where a reverse proxy in front of Sixb connects from. */
export const PRIVATE_NETWORKS = "private"

const PRIVATE_NETWORK_RANGES = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
]

export type ClientAddressResolver = (socketAddress: string, forwardedFor: string | null) => string

/**
 * Resolve the client a request came from.
 *
 * Starts at the socket peer and walks `x-forwarded-for` right to left while the current hop is a
 * trusted proxy. Each proxy appends the address it accepted the connection from, so everything left
 * of the first untrusted hop was written by the client and is never read.
 */
export function createClientAddressResolver(
  trustedProxies: readonly string[]
): ClientAddressResolver {
  const trusted = new BlockList()
  for (const entry of trustedProxies.flatMap((value) =>
    value === PRIVATE_NETWORKS ? PRIVATE_NETWORK_RANGES : [value]
  )) {
    addTrustedRange(trusted, entry)
  }
  const isTrusted = (address: string) => trusted.check(address, isIPv4(address) ? "ipv4" : "ipv6")

  return (socketAddress, forwardedFor) => {
    let address = normalizeAddress(socketAddress)
    const hops = forwardedFor?.split(",") ?? []
    for (let index = hops.length - 1; index >= 0 && isTrusted(address); index -= 1) {
      const hop = normalizeAddress(hops[index]?.trim() ?? "")
      if (!isIP(hop)) break
      address = hop
    }
    return address
  }
}

function addTrustedRange(list: BlockList, entry: string): void {
  const [address = "", prefix, ...rest] = entry.split("/")
  const family = isIP(address)
  const maxBits = family === 4 ? 32 : 128
  const bits = prefix === undefined ? maxBits : Number(prefix)
  const validPrefix = prefix === undefined || /^\d{1,3}$/.test(prefix)
  if (!family || !validPrefix || rest.length > 0 || bits > maxBits) {
    throw new Error(
      `[SixbServer] Trusted proxy '${entry}' is not an IP address, CIDR range, or '${PRIVATE_NETWORKS}'.`
    )
  }
  list.addSubnet(address, bits, family === 4 ? "ipv4" : "ipv6")
}

// Dual-stack listeners report IPv4 peers as `::ffff:a.b.c.d`.
function normalizeAddress(address: string): string {
  const lower = address.toLowerCase()
  return lower.startsWith("::ffff:") && isIPv4(lower.slice(7)) ? lower.slice(7) : lower
}
