import { randomInt } from "node:crypto"

/**
 * The ports a branch's runtime is drawn from when its sandbox is made: its front on a multiple of
 * four, its API and its app on the next two. Below the ephemeral ranges the kernels hand out to
 * outgoing connections (Linux from 32768, macOS from 49152), so no connection of the host's can
 * hold one.
 */
export const BRANCH_RUNTIME_PORTS = { from: 20_000, count: 10_000 } as const

const ATTEMPTS = 50

/** The ports one runtime takes: its front, its API and its app. */
const RUNTIME_PORTS = 3

/**
 * A port for a new sandbox, free on this host with the two after it. A sandbox of the worker's
 * own machine shares its network, and smolvm publishes on its loopback: either would fail to bind
 * a taken port. A remote sandbox has ports of its own, where any port does.
 */
export async function freeRuntimePort(): Promise<number> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = BRANCH_RUNTIME_PORTS.from + 4 * randomInt(BRANCH_RUNTIME_PORTS.count / 4)
    let free = true
    for (let offset = 0; offset < RUNTIME_PORTS && free; offset += 1) {
      free = await isFree(port + offset)
    }
    if (free) return port
  }
  throw new Error(
    `[SixbBranchWorker] No three free ports in ${BRANCH_RUNTIME_PORTS.from}-${BRANCH_RUNTIME_PORTS.from + BRANCH_RUNTIME_PORTS.count - 1} after ${ATTEMPTS} draws.`
  )
}

/** Whether this host can listen on `port` now, on every address. */
export async function isFree(port: number): Promise<boolean> {
  try {
    const listener = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } })
    listener.stop(true)
    return true
  } catch {
    return false
  }
}
