import { platform } from "node:os"

/** A hold on the computer's staying awake: ending it twice is ending it once. */
export type ReleaseAwake = () => void

/** Keeps the computer awake while any hold is held, however many turns run. */
export function createKeepAwake(start: () => (() => void) | null) {
  let holds = 0
  let stop: (() => void) | null = null

  return {
    hold(): ReleaseAwake {
      holds += 1
      if (holds === 1) stop = start()
      let released = false
      return () => {
        if (released) return
        released = true
        holds -= 1
        if (holds > 0) return
        stop?.()
        stop = null
      }
    },
  }
}

/**
 * On macOS, `caffeinate` for as long as this process lives: `-i` holds off idle sleep, on battery
 * too, and `-w` ends it with this process, so a crash can't leave the computer awake. A closed lid
 * still sleeps. Other systems stay as they are for now, and a failure only means no hold.
 */
function startCaffeinate(): (() => void) | null {
  if (platform() !== "darwin") return null
  try {
    const child = Bun.spawn(["caffeinate", "-i", "-w", String(process.pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    // It must not keep this process alive: it waits for this process to end.
    child.unref()
    return () => child.kill()
  } catch {
    return null
  }
}

/** One per process, as every folder's turns share one computer. */
export const keepAwake = createKeepAwake(startCaffeinate)
