/** @jsxImportSource @opentui/react */
import { basename } from "node:path"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useSyncExternalStore } from "react"
import {
  DEV_STARTUP_STEPS,
  type DevChildMessage,
  type DevReadyView,
  type DevStartupFailure,
} from "../../lib/dev-messages"
import type { DevControls, DevReporter } from "../../lib/dev-supervisor"
import { openUrl } from "../../lib/open-url"
import { MAX_COLUMNS, wrap } from "../layout"
import { errorView } from "../screens"
import { glyph, tone } from "../theme"
import { BOLD, Hints, Tiles, useSpinner, useTick } from "./components"
import { type LiveColors, startFooter } from "./session"

type Phase =
  /** `restart` when a dev process came before this one. */
  | { readonly kind: "starting"; readonly step: number; readonly restart: boolean }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: DevStartupFailure }
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "stopping" }

export interface DevState {
  readonly phase: Phase
  readonly view: DevReadyView | null
  /** Restarts since `sixb dev` began, by a source change or by hand. */
  readonly restarts: number
  readonly readySince: number | null
}

/** Rows the footer takes: the titled rule, a gap, three body rows, warnings, a gap, the keys. */
const FULL_ROWS = 7
/** Below this many terminal rows, the footer keeps to its titled rule and one line. */
const COMPACT_BELOW = 30
const COMPACT_ROWS = 2
const MAX_WARNINGS = 2

/**
 * `sixb dev` in a terminal: a footer that outlives every restart, showing what the dev process
 * serves and how it is doing, with the dev process's output scrolling above it.
 */
export async function startDevFooter(options: {
  readonly root: string
  readonly controls: DevControls
}): Promise<DevReporter> {
  let state: DevState = {
    phase: { kind: "starting", step: 0, restart: false },
    view: null,
    restarts: 0,
    readySince: null,
  }
  const listeners = new Set<() => void>()
  const footer = await startFooter({ rows: FULL_ROWS })
  let bootStartedAt = Date.now()

  const set = (next: Partial<DevState>) => {
    state = { ...state, ...next }
    footer.resize(
      isCompact(footer.renderer.terminalHeight) ? COMPACT_ROWS : FULL_ROWS + warningRows(state.view)
    )
    for (const listener of listeners) listener()
  }
  footer.renderer.on("resize", () => set({}))
  set({})
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => state,
  }
  // The footer's top rule names the session, so the scrollback opens with nothing but room under
  // the prompt, and only once there is something to set apart. A space, not "": the scrollback
  // drops empty lines.
  let spaced = false
  const print = (text: string) => {
    if (!spaced) footer.print(" ")
    spaced = true
    footer.print(text)
  }
  const event = (mark: string, text: string) => print(`  ${mark} ${text}  ${tone.faint(clock())}`)

  footer.render(
    <DevFooter
      store={store}
      colors={footer.colors}
      projectName={basename(options.root)}
      controls={options.controls}
    />
  )

  return {
    output: "pipe",
    line(text) {
      print(text)
    },
    message(message: DevChildMessage) {
      if (message.type === "status") {
        set({
          phase: {
            kind: "starting",
            step: DEV_STARTUP_STEPS.indexOf(message.step),
            restart: state.phase.kind === "starting" && state.phase.restart,
          },
        })
      } else if (message.type === "ready") {
        const seconds = ((Date.now() - bootStartedAt) / 1000).toFixed(1)
        const view = message.view ?? state.view
        // The footer says it is ready. The scrollback records only what changed: a restart's
        // ready line answers the change that started it.
        if (state.restarts > 0) {
          event(tone.blue(glyph.live), `${tone.strong("ready")} ${tone.muted(`in ${seconds}s`)}`)
        }
        set({ phase: { kind: "ready" }, view, readySince: Date.now() })
      } else if (message.type === "startup-error") {
        const error = message.error ?? { message: "The dev process failed to start." }
        set({ phase: { kind: "failed", error } })
        print(
          errorView({
            message: error.message,
            ...(error.remediation ? { remediation: error.remediation } : {}),
          }).replace(/^\n+|\n+$/g, "")
        )
      }
    },
    restarting(filename) {
      bootStartedAt = Date.now()
      set({
        phase: { kind: "starting", step: 0, restart: true },
        restarts: state.restarts + 1,
      })
      event(
        tone.warn(glyph.restart),
        filename ? `${filename} ${tone.muted("changed")}` : tone.muted("restart requested")
      )
    },
    exited(code) {
      // A failed start already said why it ended.
      if (state.phase.kind === "failed") return
      set({ phase: { kind: "exited", code } })
      event(tone.fail(glyph.fail), tone.muted(`dev process exited (${code})`))
    },
    timedOut() {
      set({
        phase: {
          kind: "failed",
          error: { message: "Startup timed out.", remediation: "Edit a source file to retry." },
        },
      })
      event(tone.fail(glyph.fail), "Startup timed out. Edit a source file to retry.")
    },
    error(text) {
      event(tone.fail(glyph.fail), text)
    },
    stopping() {
      set({ phase: { kind: "stopping" } })
    },
    async stop() {
      const up = state.readySince
        ? ` ${glyph.dot} up ${duration(Date.now() - state.readySince)}`
        : ""
      print(`  ${tone.faint(glyph.idle)} ${tone.muted(`sixb dev stopped${up}`)}\n`)
      await footer.stop()
    },
  }
}

function isCompact(terminalRows: number): boolean {
  return terminalRows < COMPACT_BELOW
}

function warningRows(view: DevReadyView | null): number {
  if (!view || view.warnings.length === 0) return 0
  return (
    Math.min(MAX_WARNINGS, view.warnings.length) + (view.warnings.length > MAX_WARNINGS ? 1 : 0)
  )
}

/** The footer itself, drawn from the state the reporter keeps. */
export function DevFooter({
  store,
  colors,
  projectName,
  controls,
}: {
  readonly store: { subscribe(listener: () => void): () => void; get(): DevState }
  readonly colors: LiveColors
  readonly projectName: string
  readonly controls: DevControls
}) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  // In split-footer mode the renderer's own size is the footer's; the terminal's is apart.
  // Reading the dimensions hook re-renders this on a resize.
  useTerminalDimensions()
  const renderer = useRenderer()
  const width = Math.min(renderer.terminalWidth, MAX_COLUMNS)
  const compact = isCompact(renderer.terminalHeight)
  const inner = Math.max(20, width - 6)
  const appUrl = state.view?.appUrl ?? null
  const docsUrl = state.view?.apiDocsUrl ?? null
  const keys: (readonly [string, string])[] = [
    ...(appUrl ? ([["o", compact ? "open" : "open app"]] as const) : []),
    ...(docsUrl ? ([["d", compact ? "docs" : "api docs"]] as const) : []),
    ["r", "restart"],
    ["q", "quit"],
  ]

  useKeyboard((key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.name === "q") controls.quit()
    else if (key.name === "r") controls.restart()
    else if (key.name === "o" && appUrl) void openUrl(appUrl)
    else if (key.name === "d" && docsUrl) void openUrl(docsUrl)
  })

  const title = state.view?.name ?? projectName
  if (compact) {
    return (
      <box flexDirection="column">
        <TitleRule state={state} colors={colors} title={title} width={width} />
        <box flexDirection="row" paddingLeft={3} width={width}>
          <Summary state={state} colors={colors} width={Math.max(10, inner - 34)} />
          <box flexGrow={1} />
          <Hints colors={colors} items={keys} />
        </box>
      </box>
    )
  }
  return (
    <box flexDirection="column">
      <TitleRule state={state} colors={colors} title={title} width={width} />
      <box height={1} />
      <box flexDirection="column" paddingLeft={3} height={3}>
        <Body state={state} colors={colors} width={inner} />
      </box>
      <Warnings view={state.view} colors={colors} width={inner} />
      <box height={1} />
      <box paddingLeft={3}>
        <Hints colors={colors} items={keys} />
      </box>
    </box>
  )
}

interface Part {
  readonly text: string
  readonly fg: string
  readonly bold?: boolean
}

/**
 * The footer's top edge, which also names it and says how it stands:
 *
 *   ── ▰ sixb dev · northline ──────────────── ● ready · up 4m · 2 restarts ──
 */
function TitleRule({
  state,
  colors,
  title,
  width,
}: {
  readonly state: DevState
  readonly colors: LiveColors
  readonly title: string
  readonly width: number
}) {
  const busy = state.phase.kind === "starting" || state.phase.kind === "stopping"
  const spinner = useSpinner(busy)
  useTick(5000)
  const left: Part[] = [
    { text: glyph.mark, fg: colors.blue },
    { text: " sixb dev", fg: colors.text, bold: true },
    { text: ` ${glyph.dot} ${title}`, fg: colors.muted },
  ]
  const right = statusParts(state, colors, spinner, Date.now())
  const length = (parts: readonly Part[]) => parts.reduce((sum, part) => sum + part.text.length, 0)
  const fill = Math.max(1, width - length(left) - length(right) - 8)
  return (
    <text>
      <span fg={colors.faint}>{"── "}</span>
      {left.map((part) => (
        <span key={part.text} fg={part.fg} attributes={part.bold ? BOLD : 0}>
          {part.text}
        </span>
      ))}
      <span fg={colors.faint}>{` ${"─".repeat(fill)} `}</span>
      {right.map((part, index) => (
        <span key={`${index}:${part.text}`} fg={part.fg} attributes={part.bold ? BOLD : 0}>
          {part.text}
        </span>
      ))}
      <span fg={colors.faint}>{" ──"}</span>
    </text>
  )
}

function statusParts(state: DevState, colors: LiveColors, spinner: string, now: number): Part[] {
  const phase = state.phase
  switch (phase.kind) {
    case "starting": {
      const step = Math.max(0, phase.step)
      // A restart keeps the last URLs on screen, so its progress lives up here.
      return phase.restart
        ? [
            { text: spinner, fg: colors.amber },
            { text: " restarting", fg: colors.text },
            { text: ` ${glyph.dot} ${DEV_STARTUP_STEPS[step] ?? ""}`, fg: colors.muted },
          ]
        : [
            { text: spinner, fg: colors.blue },
            { text: " starting", fg: colors.text },
          ]
    }
    case "ready":
      return [
        { text: glyph.live, fg: colors.blue },
        { text: " ready", fg: colors.text, bold: true },
        {
          text: `${state.readySince ? ` ${glyph.dot} up ${duration(now - state.readySince)}` : ""}${
            state.restarts > 0
              ? ` ${glyph.dot} ${state.restarts} restart${state.restarts === 1 ? "" : "s"}`
              : ""
          }`,
          fg: colors.muted,
        },
      ]
    case "failed":
    case "exited":
      return [
        {
          text: `${glyph.fail} ${phase.kind === "failed" ? "failed" : "stopped"}`,
          fg: colors.red,
          bold: true,
        },
        { text: ` ${glyph.dot} waiting for a change`, fg: colors.muted },
      ]
    case "stopping":
      return [
        { text: spinner, fg: colors.muted },
        { text: " stopping", fg: colors.muted },
      ]
  }
}

/** The one line a compact footer has for its state. */
function Summary({
  state,
  colors,
  width,
}: {
  readonly state: DevState
  readonly colors: LiveColors
  readonly width: number
}) {
  const phase = state.phase
  if (phase.kind === "failed") return <text fg={colors.red}>{fit(phase.error.message, width)}</text>
  if (phase.kind === "starting" && !state.view) {
    return <StartupProgress step={phase.step} colors={colors} />
  }
  return (
    <text>
      <span fg={colors.muted}>{"app "}</span>
      <span fg={phase.kind === "ready" ? colors.blue : colors.muted}>
        {fit(state.view?.appUrl ?? "not running", width - 4)}
      </span>
    </text>
  )
}

function Body({
  state,
  colors,
  width,
}: {
  readonly state: DevState
  readonly colors: LiveColors
  readonly width: number
}) {
  const phase = state.phase
  if (phase.kind === "failed") {
    const lines = wrap(phase.error.message, width)
    const [first = "", second] = lines
    return (
      <>
        <text fg={colors.red}>{first}</text>
        <text fg={colors.red}>
          {second ? (lines.length > 2 ? fit(`${second} …`, width) : second) : " "}
        </text>
        <text fg={colors.muted}>
          {fit(phase.error.remediation ?? "Save a source file to retry, or press r.", width)}
        </text>
      </>
    )
  }
  if (phase.kind === "exited") {
    return (
      <>
        <text fg={colors.text}>{`The dev process exited (${phase.code}).`}</text>
        <text fg={colors.muted}>
          {fit("Its output is above. Save a source file to start it again, or press r.", width)}
        </text>
        <text> </text>
      </>
    )
  }
  if (state.view) {
    return <Serving view={state.view} colors={colors} width={width} dim={phase.kind !== "ready"} />
  }

  return (
    <>
      <StartupProgress step={phase.kind === "starting" ? phase.step : 0} colors={colors} />
      <text> </text>
      <text> </text>
    </>
  )
}

/** The first start's progress: tiles filling as the steps pass, then the step running now. */
function StartupProgress({ step, colors }: { readonly step: number; readonly colors: LiveColors }) {
  const current = Math.max(0, step)
  return (
    <text>
      <Tiles colors={colors} filled={current + 1} total={DEV_STARTUP_STEPS.length + 1} />
      <span fg={colors.text}>{`  ${DEV_STARTUP_STEPS[current] ?? "Starting"}…`}</span>
    </text>
  )
}

function Serving({
  view,
  colors,
  width,
  dim,
}: {
  readonly view: DevReadyView
  readonly colors: LiveColors
  readonly width: number
  readonly dim: boolean
}) {
  const value = dim ? colors.muted : colors.blue
  const extras = `   docs ${pathOf(view.apiDocsUrl)}   events ${pathOf(view.wsUrl)}`
  const workers = view.workers.map((worker) => `${worker.type} ${worker.concurrency}`).join(" · ")
  return (
    <>
      <text>
        <span fg={colors.muted}>{"app      "}</span>
        {view.appUrl ? (
          <span fg={value}>{view.appUrl}</span>
        ) : (
          <span fg={colors.faint}>not running</span>
        )}
      </text>
      <text>
        <span fg={colors.muted}>{"api      "}</span>
        <span fg={value}>{view.apiUrl}</span>
        <span fg={colors.faint}>{fit(extras, Math.max(0, width - 9 - view.apiUrl.length))}</span>
      </text>
      <text>
        <span fg={colors.muted}>{"workers  "}</span>
        <span fg={dim ? colors.muted : colors.text}>
          {workers ? fit(workers, width - 9) : "none registered"}
        </span>
      </text>
    </>
  )
}

function Warnings({
  view,
  colors,
  width,
}: {
  readonly view: DevReadyView | null
  readonly colors: LiveColors
  readonly width: number
}) {
  if (!view || view.warnings.length === 0) return null
  const shown = view.warnings.slice(0, MAX_WARNINGS)
  const more = view.warnings.length - shown.length
  return (
    <box flexDirection="column" paddingLeft={3}>
      {shown.map((warning) => (
        <text key={warning}>
          <span fg={colors.amber}>{`${glyph.warn} `}</span>
          <span fg={colors.muted}>{fit(warning, width - 2)}</span>
        </text>
      ))}
      {more > 0 ? <text fg={colors.faint}>{`  and ${more} more`}</text> : null}
    </box>
  )
}

function fit(text: string, width: number): string {
  if (width <= 1) return ""
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8)
}
