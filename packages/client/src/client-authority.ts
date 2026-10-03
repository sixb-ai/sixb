import type { Client } from "./generated/client"
import type { SixbSessionOptions } from "./session"

const sharedAuthorityClients = new WeakMap<Client, string>()
const sessionAuthorityClients = new WeakMap<Client, SixbSessionOptions>()

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

/** Record the Share a client speaks for, or `null` when it carries no shared authority. */
export function markClientSharedAuthority(client: Client, grantId: string | null): void {
  if (grantId !== null) {
    sharedAuthorityClients.set(client, grantId)
    return
  }

  sharedAuthorityClients.delete(client)
}

export function hasClientSharedAuthority(client: Client): boolean {
  return sharedAuthorityClients.has(client)
}

export function getClientSharedGrantId(client: Client): string | null {
  return sharedAuthorityClients.get(client) ?? null
}

/** Record the native session a client signs in with, so its WebSockets can present it too. */
export function markClientSessionAuthority(
  client: Client,
  session: SixbSessionOptions | null
): void {
  if (session) {
    sessionAuthorityClients.set(client, session)
    return
  }

  sessionAuthorityClients.delete(client)
}

export function getClientSessionAuthority(client: Client): SixbSessionOptions | null {
  return sessionAuthorityClients.get(client) ?? null
}
