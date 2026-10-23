import { client, createArtifactFrame } from "@sixb/client"
import {
  FRAME_PROTOCOL,
  FRAME_THEME_TOKENS,
  type FrameCallResult,
  type FrameEvent,
  type FrameRequest,
  type FrameStart,
  frameStartHash,
  parseFrameCall,
  parseFrameEvent,
} from "@sixb/core/artifacts"
import { cn } from "@sixb/ui/lib/utils"
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react"
import { answerQueryCall } from "./page-queries"
import { answerStateCall, onPageStateReset } from "./page-state"
import { type ArtifactVersion, useArtifactTheme } from "./queries"

/** Asks the deck in the frame to do something; resolves when it has. */
export interface ArtifactFrameHandle {
  send<Method extends FrameRequest["method"]>(
    method: Method,
    params: Extract<FrameRequest, { method: Method }>["params"]
  ): Promise<void>
}

/** A frame link lasts an hour; one is reused while it has most of that left. */
const FRAME_REUSE_MS = 40 * 60 * 1000

/** How long a deck has to say it is ready before a frame that reports failure gives up on it. */
const READY_TIMEOUT_MS = 20_000

/**
 * A version in a sandboxed frame, served from the API under a short-lived link. The frame has an
 * opaque origin, so its page cannot read the app's cookies or call the API as the reader: it
 * talks to the app only in messages, and the app listens only to its own frame and reads only
 * events of the protocol's shape. The app's theme goes in as tokens, read where the frame is
 * mounted, so an artifact's theme applies too.
 *
 * The frame stays hidden until its theme is applied, then fades in over `fallback`: until the
 * tokens arrive, a deck paints in the kit's light defaults, which flash on a dark page.
 *
 * A page in it keeps data with `sixb.state`, and reads its version's queries with `sixb.query`: the
 * frame's calls are answered here, for the artifact and the version it shows and the signed-in
 * reader, however many frames of it are open.
 */
export function ArtifactFrame({
  version,
  entry = version.entry,
  title,
  onEvent,
  className,
  handle,
  start,
  decorative = false,
  fallback,
  failure,
  overlay,
}: {
  readonly version: ArtifactVersion
  /** The page it opens, one of the version's frame entries: its entry, or a canvas's board. */
  readonly entry?: string
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
   * What shows instead when the deck cannot open: no link could be had for it, or it never said
   * it was ready. A frame that reports failure loads at once; others wait until they near the
   * viewport.
   */
  readonly failure?: ReactNode
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
  // The source that has said it is ready, and the one it has shown, themed: a new source starts
  // hidden again.
  const [ready, setReady] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState<string | null>(null)
  const reportsFailure = failure !== undefined
  const queries = useQueryClient()
  // What the frame shows when it calls: a pinned version runs that version's queries.
  const shows = useRef(version)
  shows.current = version

  const frame = useQuery(frameLink(version))

  // Each frame keeps the link it loaded until it loads again: every frame of a version shares the
  // query, and a link minted for a later mount would otherwise load every mounted frame again, at
  // its start.
  const identity = `${version.artifactId}@${version.version}`
  const [kept, setKept] = useState<{ readonly identity: string; readonly path: string } | null>(
    null
  )
  if (frame.data && kept?.identity !== identity) setKept({ identity, path: frame.data.path })
  const path = kept?.identity === identity ? kept.path : undefined
  const source = path ? `${frameUrl(path, entry)}${frameStartHash(start ?? {})}` : undefined
  const sourceRef = useRef(source)
  sourceRef.current = source
  const pathRef = useRef(path)
  pathRef.current = path

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

  // A frame that loads again, or goes, answers nothing it was asked before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new source is a new frame.
  useEffect(() => {
    const requests = pending.current
    return () => {
      for (const request of requests.values()) {
        request.reject(new Error("[SixbApp] The frame closed before it answered."))
      }
      requests.clear()
    }
  }, [source])

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

  useEffect(
    () =>
      onFrameMessage((message) => {
        // Only the frame this component holds speaks to it.
        if (!iframe.current || message.source !== iframe.current.contentWindow) return
        const data = message.data as Record<string, unknown> | null
        if (!data || data.protocol !== FRAME_PROTOCOL) return
        if ("call" in data) {
          const call = parseFrameCall(data)
          const frame = message.source as Window
          const answer = (result: Omit<FrameCallResult, "protocol">) =>
            frame.postMessage({ protocol: FRAME_PROTOCOL, ...result }, "*")
          if (!call) {
            // A call the protocol can't take still settles, so the page's promise never hangs.
            if (Number.isSafeInteger(data.call)) {
              const api = String(data.method).startsWith("query.") ? "sixb.query" : "sixb.state"
              answer({ result: Number(data.call), error: `[SixbApp] ${api} refused the call.` })
            }
            return
          }

          const answered =
            call.method === "query.run"
              ? answerQueryCall(queries, shows.current, call)
              : answerStateCall(queries, shows.current.artifactId, call)
          answered.then(
            (value) => answer({ result: call.call, ...(value === undefined ? {} : { value }) }),
            (error: unknown) =>
              answer({
                result: call.call,
                error: error instanceof Error ? error.message : String(error),
              })
          )
          return
        }
        if (typeof data.id === "number") {
          const request = pending.current.get(data.id)
          pending.current.delete(data.id)
          if (typeof data.error === "string") request?.reject(new Error(data.error))
          else request?.resolve()
          return
        }
        const event = parseFrameEvent(data)
        if (!event) return
        if (event.event === "ready") {
          const loaded = sourceRef.current ?? null
          setReady(loaded)
          sendTheme().then(() => setShown(loaded))
        }
        onEventRef.current?.(event)
      }),
    [sendTheme, queries]
  )

  // A frame that loads again does it on a link that still works: the one it kept may have
  // expired while it was open. A newer link is a new source, and the same one reloads in place.
  const reload = useCallback(async () => {
    const link = await queries.fetchQuery(frameLink(version))

    if (link.path === pathRef.current) return send("reload", {})

    setKept({ identity: `${version.artifactId}@${version.version}`, path: link.path })
  }, [queries, send, version])

  // A page whose data was reset starts over, wherever it is open.
  useEffect(
    () =>
      onPageStateReset((reset) => {
        if (reset !== shows.current.artifactId) return

        reload().catch(() => send("reload", {}).catch(() => {}))
      }),
    [reload, send]
  )

  // A ready frame has the theme as it was then. The app's mode changes the class on <html>, and an
  // artifact's own theme arrives with its file and changes the classes and tokens around the
  // frame: either sends it again.
  const isReady = source !== undefined && ready === source
  useEffect(() => {
    if (!isReady) return
    return onAppThemeChange(() => {
      sendTheme()
    })
  }, [isReady, sendTheme])
  const artifactTheme = useArtifactTheme(version)
  const themed = useRef(artifactTheme)
  useEffect(() => {
    if (themed.current === artifactTheme) return
    themed.current = artifactTheme
    if (isReady) sendTheme()
  }, [artifactTheme, isReady, sendTheme])

  // A picture of the deck takes no focus, and neither does what it holds: `tabIndex` alone would
  // leave its links in the page's tab order.
  const attach = useCallback(
    (element: HTMLIFrameElement | null) => {
      iframe.current = element
      if (element && decorative) element.inert = true
    },
    [decorative]
  )

  useEffect(() => {
    if (!reportsFailure || !source || ready === source) return
    const timer = setTimeout(() => setTimedOut(source), READY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [reportsFailure, source, ready])
  // A link that fails for a later mount leaves a frame that has one as it is.
  const failed =
    reportsFailure && (source === undefined ? frame.isError : timedOut === source && !isReady)

  return (
    <div className={cn("relative min-h-0 min-w-0", className)}>
      {failed ? <div className="absolute inset-0 flex">{failure}</div> : fallback}
      {source ? (
        <iframe
          ref={attach}
          key={source}
          src={source}
          title={title}
          loading={reportsFailure ? "eager" : "lazy"}
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

/** A version's frame link, shared by its frames and reused while it has most of its hour left. */
function frameLink(version: ArtifactVersion) {
  return queryOptions({
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
}

/** The frame's entry on the API, which may be another origin than the app's. */
function frameUrl(path: string, entry: string): string {
  const base = client.getConfig().baseUrl || window.location.origin
  return new URL(`${path}${entry.split("/").map(encodeURIComponent).join("/")}`, base).toString()
}

/**
 * One listener on the page for every frame mounted, however many a deck's filmstrip holds: the
 * first subscriber attaches it, and the last to leave takes it away.
 */
function shared<Value>(attach: (dispatch: (value: Value) => void) => () => void) {
  const listeners = new Set<(value: Value) => void>()
  let detach: (() => void) | null = null
  return (listener: (value: Value) => void): (() => void) => {
    listeners.add(listener)
    detach ??= attach((value) => {
      for (const each of listeners) each(value)
    })
    return () => {
      listeners.delete(listener)
      if (listeners.size > 0) return
      detach?.()
      detach = null
    }
  }
}

const onFrameMessage = shared<MessageEvent>((dispatch) => {
  window.addEventListener("message", dispatch)
  return () => window.removeEventListener("message", dispatch)
})

const onAppThemeChange = shared<void>((dispatch) => {
  const observer = new MutationObserver(() => dispatch())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
  return () => observer.disconnect()
})
