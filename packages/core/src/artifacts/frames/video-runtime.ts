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
 *   the page again, `video.pick` finds the words under a point of the picture for the editor to
 *   type over, and any other it refuses.
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
      case "video.pick": {
        const params = (data.params ?? {}) as Record<string, unknown>
        post({ id: data.id })
        post({
          event: "video.picked",
          params: { target: wordsAt(Number(params.x), Number(params.y)) },
        })
        return
      }
      default:
        post({ id: data.id, error: `A video's frame does not answer '${data.method}'.` })
    }
  })

  // The tags whose words the editor types over, when they hold words alone: as the editor reads
  // a scene's file (`video/timeline.ts`).
  const TEXT_TAGS = [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "span",
    "div",
    "li",
    "strong",
    "em",
    "small",
    "blockquote",
    "figcaption",
    "label",
    "a",
    "button",
  ]

  /** An element's words when it holds words alone, line breaks aside; null for any other. */
  const wordsOf = (element: Element): string | null => {
    if (!TEXT_TAGS.includes(element.tagName.toLowerCase())) return null
    let words = ""
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === 1) {
        if (!["BR", "WBR"].includes((node as Element).tagName)) return null
        words += " "
      } else if (node.nodeType === 3) {
        words += node.textContent ?? ""
      }
    }
    const text = words.replace(/\s+/g, " ").trim()
    return text === "" ? null : text
  }

  /** The words shown at a point of the picture, in fractions of it, with where they are. */
  const wordsAt = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const width = window.innerWidth
    const height = window.innerHeight
    let element = document.elementFromPoint(x * width, y * height)
    while (element && element !== document.body) {
      const text = wordsOf(element)
      const composition = element.closest("[data-composition-id]")
      if (text !== null && composition) {
        const tag = element.tagName.toLowerCase()
        const same = Array.from(composition.querySelectorAll(tag)).filter(
          (each) => each.closest("[data-composition-id]") === composition && wordsOf(each) === text
        )
        const box = element.getBoundingClientRect()
        return {
          scene: composition.getAttribute("data-composition-id"),
          tag,
          text,
          occurrence: Math.max(0, same.indexOf(element)),
          rect: {
            x: box.left / width,
            y: box.top / height,
            width: box.width / width,
            height: box.height / height,
          },
        }
      }
      element = element.parentElement
    }
    return null
  }

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
