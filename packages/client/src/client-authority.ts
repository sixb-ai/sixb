import type { Client } from "./generated/client"

const sharedAuthorityClients = new WeakSet<Client>()

export const SHARED_ACCESS_REALTIME_UNAVAILABLE =
  "Live updates are unavailable during shared access."

export function assertSharedAccessGrantId(grantId: unknown): asserts grantId is string {
  if (
    typeof grantId !== "string" ||
    grantId.length === 0 ||
    grantId.length > 128 ||
    grantId.trim() !== grantId ||
    grantId.includes("\0")
  ) {
    throw new Error("[SixbClient] Shared access grant id is invalid.")
  }
}

export function markClientSharedAuthority(client: Client, shared: boolean): void {
  if (shared) {
    sharedAuthorityClients.add(client)
    return
  }

  sharedAuthorityClients.delete(client)
}

export function hasClientSharedAuthority(client: Client): boolean {
  return sharedAuthorityClients.has(client)
}
