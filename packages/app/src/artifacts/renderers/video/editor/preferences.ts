const EVERY_SCENE_KEY = "sixb.video-editor.every-scene"

/** Whether the reader last chose to see every scene's clips on the timeline, in this browser. */
export function readEveryScene(): boolean {
  try {
    return globalThis.localStorage?.getItem(EVERY_SCENE_KEY) === "true"
  } catch {
    return false
  }
}

export function writeEveryScene(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(EVERY_SCENE_KEY, "true")
    else globalThis.localStorage?.removeItem(EVERY_SCENE_KEY)
  } catch {
    // Storage can be full or blocked; the timeline simply opens on the open scene next time.
  }
}
