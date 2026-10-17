import { client, createArtifactFrame } from "@sixb/client"
import {
  FRAME_PROTOCOL,
  FRAME_THEME_TOKENS,
  type FrameEvent,
  type FrameRequest,
  type FrameStart,
  frameStartHash,
} from "@sixb/core/internal/artifacts/frame-protocol"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import type { ArtifactVersion } from "./queries"

/** Asks the deck in the frame to do something; resolves when it has. */
export interface ArtifactFrameHandle {
  send<Method extends FrameRequest["method"]>(
    method: Method,
    params: Extract<FrameRequest, { method: Method }>["params"]
  ): Promise<void>
}

/** A frame link lasts an hour; one is reused while it has most of that left. */
const FRAME_REUSE_MS = 40 * 60 * 1000

/**
 * A version in a sandboxed frame, served from the API under a short-lived link. The frame has an
 * opaque origin, so its page cannot read the app's cookies or call the API as the reader: it
 * talks to the app only in messages, and the app listens only to its own frame. The app's theme
 * goes in as tokens, read where the frame is mounted, so an artifact's theme applies too.
 *
 * The frame stays hidden until its theme is applied, then fades in over `fallback`: until the
 * tokens arrive, a deck paints in the kit's light defaults, which flash on a dark page.
 */
export function ArtifactFrame({
  version,
  title,
  onEvent,
  className,
  handle,
  start,
  decorative = false,
  fallback,
  overlay,
}: {
  readonly version: ArtifactVersion
  readonly title: string
  /** How it opens; a change loads the frame again, so this is for where it starts. */
  readonly start?: FrameStart
  /** A picture of the deck, as a thumbnail is: it takes no focus, clicks, or reading. */
  readonly decorative?: boolean
  readonly onEvent?: (event: FrameEvent) => void
  readonly className?: string
  /** What shows where the frame will be while it loads, and under it as it fades in. */
  readonly fallback?: ReactNode
  /**
   * What the app draws over the frame, in the frame's own pixels, once the frame shows: another
   * artifact a deck embeds. Clicks reach the frame except where the overlay draws.
   */
  readonly overlay?: ReactNode
  /** Where to put the handle that asks the frame for things (`ref` is not a prop in React 18). */
  readonly handle?: Ref<ArtifactFrameHandle>
}) {
  const iframe = useRef<HTMLIFrameElement | null>(null)
  const pending = useRef(new Map<number, { resolve: () => void; reject: (error: Error) => void }>())
  const nextId = useRef(0)
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  // The source the frame has shown, themed; a new source starts hidden again.
  const [shown, setShown] = useState<string | null>(null)
  const sourceRef = useRef<string | undefined>(undefined)

  const frame = useQuery({
    queryKey: ["artifact-frame", version.artifactId, version.version],
    queryFn: async () => {
      const { data } = await createArtifactFrame({
        path: { artifactId: version.artifactId, version: String(version.version) },
        throwOnError: true,
      })
      return data
    },
    staleTime: FRAME_REUSE_MS,
    gcTime: FRAME_REUSE_MS,
    retry: false,
  })

  const send = useCallback<ArtifactFrameHandle["send"]>((method, params) => {
    const target = iframe.current?.contentWindow
    if (!target) return Promise.reject(new Error("[SixbApp] The frame is not loaded."))
    nextId.current += 1
    const id = nextId.current
    return new Promise<void>((resolve, reject) => {
      pending.current.set(id, { resolve, reject })
      // The frame's origin is opaque, so a target origin cannot name it.
      target.postMessage({ protocol: FRAME_PROTOCOL, id, method, params }, "*")
    })
  }, [])
  useImperativeHandle(handle, () => ({ send }), [send])

  const sendTheme = useCallback(async () => {
    const host = iframe.current?.parentElement
    if (!host) return
    const style = getComputedStyle(host)
    const tokens: Record<string, string> = {}
    for (const token of FRAME_THEME_TOKENS) {
      const value = style.getPropertyValue(token).trim()
      if (value) tokens[token] = value
    }
    const dark = host.closest(".dark, .light")?.classList.contains("dark") ?? false
    await send("theme", { tokens, dark }).catch(() => {})
  }, [send])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the frame this component holds speaks to it.
      if (!iframe.current || event.source !== iframe.current.contentWindow) return
      const data = event.data as Record<string, unknown> | null
      if (!data || data.protocol !== FRAME_PROTOCOL) return
      if (typeof data.id === "number") {
        const request = pending.current.get(data.id)
        pending.current.delete(data.id)
        if (typeof data.error === "string") request?.reject(new Error(data.error))
        else request?.resolve()
        return
      }
      if (typeof data.event !== "string") return
      if (data.event === "ready") {
        const source = sourceRef.current
        sendTheme().then(() => setShown(source ?? null))
      }
      onEventRef.current?.(data as unknown as FrameEvent)
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [sendTheme])

  // The app's mode and an artifact's theme change classes up the tree: send the theme again.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      sendTheme()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [sendTheme])

  const source = frame.data
    ? `${frameUrl(frame.data.path, version.entry)}${frameStartHash(start ?? {})}`
    : undefined
  sourceRef.current = source
  return (
    <div className={cn("relative min-h-0 min-w-0", className)}>
      {fallback}
      {source ? (
        <iframe
          ref={iframe}
          key={source}
          src={source}
          title={title}
          className={cn(
            "absolute inset-0 size-full border-0 bg-transparent transition-opacity duration-200 ease-out motion-reduce:transition-none",
            shown === source ? "opacity-100" : "opacity-0"
          )}
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals"
          referrerPolicy="no-referrer"
          allow="fullscreen"
          {...(decorative
            ? { tabIndex: -1, "aria-hidden": true, style: { pointerEvents: "none" } }
            : {})}
        />
      ) : null}
      {overlay && source && shown === source ? (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">{overlay}</div>
      ) : null}
    </div>
  )
}

/** The frame's entry on the API, which may be another origin than the app's. */
function frameUrl(path: string, entry: string): string {
  const base = client.getConfig().baseUrl || window.location.origin
  return new URL(`${path}${entry.split("/").map(encodeURIComponent).join("/")}`, base).toString()
}
