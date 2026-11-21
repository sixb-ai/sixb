/**
 * The runtime a video's frame injects in place of `frameRuntime`, before HyperFrames' own, which
 * plays the video and answers the app's controls to it (`hf-parent`). It is served as this
 * function's own source, `(${videoFrameRuntime})()`, so it names nothing outside itself: the
 * protocol string repeats what `protocol.ts` declares, and a test holds the two together.
 *
 * A video's frame shares none of a page's: no kit, no theme, no links or embeds, as a video looks
 * as it renders, in its own colors. This one only speaks the frame protocol's little a video needs:
 *
 * - It says the frame is ready, or that the video cannot start: HyperFrames' runtime did not load,
 *   or stopped at its startup. Waiting for a timeline either would never build helps no one.
 * - It answers the app's requests: `theme` it takes and leaves the video as it is, `reload` loads
 *   the page again, and any other it refuses.
 * - On a phone, the reader's tap on play reaches the frame as the app's message, and WebKit lets
 *   only what that moment starts make a sound: the first play starts and stops every recording
 *   the page holds then, so that each may play later, when its scene comes, as HyperFrames' own
 *   player does.
 */
export function videoFrameRuntime(): void {
  const PROTOCOL = "sixb-frame/1"
  const post = (message: Record<string, unknown>) =>
    window.parent.postMessage({ protocol: PROTOCOL, ...message }, "*")

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return
    const data = event.data as Record<string, unknown> | null
    if (!data || data.protocol !== PROTOCOL || typeof data.id !== "number") return
    if (typeof data.method !== "string") return

    switch (data.method) {
      case "theme":
        post({ id: data.id })
        return
      case "reload":
        post({ id: data.id })
        // After the answer is posted, so the app hears it before the page goes.
        setTimeout(() => window.location.reload())
        return
      default:
        post({ id: data.id, error: `A video's frame does not answer '${data.method}'.` })
    }
  })

  // A phone's WebKit plays a recording with sound only once the reader's gesture started it: the
  // app's first `play`, sent as they tap, carries that gesture here.
  const touchWebKit =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  if (touchWebKit) {
    const prime = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown> | null
      if (event.source !== window.parent || data?.source !== "hf-parent") return
      if (data.type !== "control" || data.action !== "play") return

      window.removeEventListener("message", prime, true)
      for (const media of Array.from(document.querySelectorAll("video, audio"))) {
        const recording = media as HTMLMediaElement
        if (!recording.paused) continue
        recording.play().catch(() => {})
        recording.pause()
      }
    }
    window.addEventListener("message", prime, true)
  }

  // HyperFrames' runtime runs in the page's head, after this one: once the page is parsed, it is
  // there, or it never loaded. Its startup runs next, and an error it stops at is saved before it
  // is thrown.
  const ready = () => {
    const player = window as Window & { __hyperframes?: unknown; __hfStartupError?: unknown }
    if (!player.__hyperframes) {
      post({ event: "failed", params: {} })
      return
    }
    window.addEventListener("error", () => {
      if (typeof player.__hfStartupError === "string") post({ event: "failed", params: {} })
    })

    post({ event: "ready", params: {} })
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready)
  else ready()
}
