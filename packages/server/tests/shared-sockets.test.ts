import { describe, expect, test } from "bun:test"
import type { SharedSessionContext } from "@sixb/core/internal/shares"
import type { SharedAccessBoundary } from "../src/auth/shared-access"
import { type ClosableSocket, SharedSockets } from "../src/routes/ws/shared-sockets"

/** A boundary that counts the session reads, and names a guest on demand. */
function fakeBoundary() {
  let named: ((sessionId: string) => void) | undefined
  const reads: string[] = []
  const boundary = {
    onGuestNamed: (listener: (sessionId: string) => void) => {
      named = listener
    },
    current: async (session: SharedSessionContext) => {
      reads.push(session.sessionId)
      return session
    },
  } as unknown as SharedAccessBoundary
  return { boundary, reads, name: (sessionId: string) => named?.(sessionId) }
}

describe("the sockets of shared links' sessions", () => {
  // Elysia hands `open` and `close` each a wrapper of its own around one raw socket. Guard proof:
  // delete the session's socket by its wrapper again in SharedSockets.close; the closed socket is
  // then kept for as long as the server runs.
  test("forget a socket that closed, whichever wrapper closes it", async () => {
    const { boundary, reads, name } = fakeBoundary()
    const sockets = new SharedSockets(boundary)

    // Opened and closed through two wrappers, as Elysia does, and then dropped by the server.
    const opened = (() => {
      const raw = {}
      const data = { sharedSession: { grantId: "shr_1", sessionId: "shs_1" } }
      // Two wrappers around the one raw socket, as Elysia gives each handler its own.
      const wrapper = (): ClosableSocket =>
        Object.assign({ close: () => undefined }, { raw, data }) as ClosableSocket
      sockets.open(wrapper())
      name("shs_1")
      sockets.close(wrapper())
      return new WeakRef(raw)
    })()
    expect(reads).toEqual(["shs_1"])

    // The session read settles; then nothing holds the socket but the server's registry.
    await new Promise((settled) => setTimeout(settled, 0))
    Bun.gc(true)
    expect(opened.deref()).toBeUndefined()
  })
})
