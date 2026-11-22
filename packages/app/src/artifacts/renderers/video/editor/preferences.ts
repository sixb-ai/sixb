// The timeline's choices each reader keeps in this browser. Each is off unless they turned it on.

const MAGNETIC_KEY = "sixb.video-editor.magnetic"

/** Whether the reader last chose that a trim or a delete closes the gap it leaves. */
export const readMagnetic = () => readChoice(MAGNETIC_KEY)
export const writeMagnetic = (on: boolean) => writeChoice(MAGNETIC_KEY, on)

function readChoice(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "true"
  } catch {
    return false
  }
}

function writeChoice(key: string, on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(key, "true")
    else globalThis.localStorage?.removeItem(key)
  } catch {
    // Storage can be full or blocked; the choice is simply off again next time.
  }
}
