/** @jsxImportSource @opentui/react */
import { basename, resolve } from "node:path"
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useSyncExternalStore } from "react"
import {
  DEV_STARTUP_STEPS,
  type DevChildMessage,
  type DevReadyView,
  type DevStartupFailure,
} from "../../lib/dev-messages"
import type { DevControls, DevReporter } from "../../lib/dev-supervisor"
import { openUrl } from "../../lib/open-url"
import { wrap } from "../layout"
import { errorView, relativePath } from "../screens"
import { glyph, tone } from "../theme"
import { BOLD, Hints, Rule, Tiles, useSpinner, useTick } from "./components"
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

/** Rows the footer takes: rule, header, gap, three body rows, warnings, gap, hints. */
const BASE_ROWS = 8
const MAX_WARNINGS = 2

/**
 * `sixb dev` in a terminal: a footer that outlives every restart, showing what the dev process
 * serves and how it is doing, with the dev process's output scrolling above it.
 */
export async function startDevFooter(options: {
  readonly root: string
  readonly entry?: string
  readonly controls: DevControls
}): Promise<DevReporter> {
  let state: DevState = {
    phase: { kind: "starting", step: 0, restart: false },
    view: null,
    restarts: 0,
    readySince: null,
  }
  const listeners = new Set<() => void>()
  const footer = await startFooter({ rows: BASE_ROWS })
  let bootStartedAt = Date.now()

  const set = (next: Partial<DevState>) => {
    state = { ...state, ...next }
    footer.resize(BASE_ROWS + warningRows(state.view))
    for (const listener of listeners) listener()
  }
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => state,
  }
  const event = (mark: string, text: string) =>
    footer.print(`  ${mark} ${text}  ${tone.faint(clock())}`)

  footer.print(
    `\n  ${tone.blue(glyph.mark)} ${tone.strong("sixb dev")}  ${tone.muted(basename(options.root))}\n `
  )
  footer.render(
    <DevFooter
      store={store}
      colors={footer.colors}
      entry={relativePath(resolve(options.entry ?? "sixb.config.ts"))}
      projectName={basename(options.root)}
      controls={options.controls}
    />
  )

  return {
    output: "pipe",
    line(text) {
      footer.print(text)
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
        set({ phase: { kind: "ready" }, view, readySince: Date.now() })
        event(tone.blue(glyph.live), `${tone.strong("ready")} ${tone.muted(`in ${seconds}s`)}`)
      } else if (message.type === "startup-error") {
        const error = message.error ?? { message: "The dev process failed to start." }
        set({ phase: { kind: "failed", error } })
        footer.print(
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
      footer.print(`  ${tone.faint(glyph.idle)} ${tone.muted(`sixb dev stopped${up}`)}\n`)
      await footer.stop()
    },
  }
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
  entry,
  projectName,
  controls,
}: {
  readonly store: { subscribe(listener: () => void): () => void; get(): DevState }
  readonly colors: LiveColors
  readonly entry: string
  readonly projectName: string
  readonly controls: DevControls
}) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const { width } = useTerminalDimensions()
  const inner = Math.max(20, width - 4)
  const appUrl = state.view?.appUrl ?? null
  const docsUrl = state.view?.apiDocsUrl ?? null

  useKeyboard((key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.name === "q") controls.quit()
    else if (key.name === "r") controls.restart()
    else if (key.name === "o" && appUrl) void openUrl(appUrl)
    else if (key.name === "d" && docsUrl) void openUrl(docsUrl)
  })

  return (
    <box flexDirection="column">
      <Rule colors={colors} />
      <box flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
        <text>
          <span fg={colors.blue}>{glyph.mark}</span>
          <span fg={colors.text} attributes={BOLD}>
            {" sixb dev"}
          </span>
          <span fg={colors.muted}>{`  ${state.view?.name ?? projectName}`}</span>
        </text>
        <Status state={state} colors={colors} />
      </box>
      <box height={1} />
      <box flexDirection="column" paddingLeft={4} paddingRight={2} height={3}>
        <Body state={state} colors={colors} entry={entry} width={inner - 2} />
      </box>
      <Warnings view={state.view} colors={colors} width={inner - 2} />
      <box height={1} />
      <box paddingLeft={2}>
        <Hints
          colors={colors}
          items={[
            ...(appUrl ? ([["o", "open app"]] as const) : []),
            ...(docsUrl ? ([["d", "api docs"]] as const) : []),
            ["r", "restart"],
            ["q", "quit"],
          ]}
        />
      </box>
    </box>
  )
}

function Status({ state, colors }: { readonly state: DevState; readonly colors: LiveColors }) {
  const spinner = useSpinner(state.phase.kind === "starting" || state.phase.kind === "stopping")
  useTick(5000)
  const now = Date.now()
  const phase = state.phase
  switch (phase.kind) {
    case "starting":
      return (
        <text>
          <span fg={phase.restart ? colors.amber : colors.blue}>{spinner}</span>
          <span fg={colors.text}>{phase.restart ? " restarting" : " starting"}</span>
        </text>
      )
    case "ready": {
      const up = state.readySince ? `up ${duration(now - state.readySince)}` : ""
      const restarts =
        state.restarts > 0
          ? `  ${glyph.dot}  ${state.restarts} restart${state.restarts === 1 ? "" : "s"}`
          : ""
      return (
        <text>
          <span fg={colors.blue}>{glyph.live}</span>
          <span fg={colors.text} attributes={BOLD}>
            {" ready"}
          </span>
          <span fg={colors.muted}>{`  ${up}${restarts}`}</span>
        </text>
      )
    }
    case "failed":
    case "exited":
      return (
        <text>
          <span fg={colors.red} attributes={BOLD}>
            {`${glyph.fail} ${phase.kind === "failed" ? "failed" : "stopped"}`}
          </span>
          <span fg={colors.muted}>{"  waiting for a source change"}</span>
        </text>
      )
    case "stopping":
      return (
        <text>
          <span fg={colors.muted}>{spinner}</span>
          <span fg={colors.muted}>{" stopping"}</span>
        </text>
      )
  }
}

function Body({
  state,
  colors,
  entry,
  width,
}: {
  readonly state: DevState
  readonly colors: LiveColors
  readonly entry: string
  readonly width: number
}) {
  const phase = state.phase
  if (phase.kind === "failed") {
    const [first = "", second] = wrap(phase.error.message, width)
    const more = wrap(phase.error.message, width).length > 2
    return (
      <>
        <text fg={colors.red}>{first}</text>
        <text fg={colors.red}>{second ? (more ? fit(`${second} …`, width) : second) : " "}</text>
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
  if (state.view && phase.kind !== "starting")
    return <Serving view={state.view} colors={colors} width={width} dim={phase.kind !== "ready"} />

  const step = phase.kind === "starting" ? Math.max(0, phase.step) : 0
  return (
    <>
      <text>
        <Tiles colors={colors} filled={step + 1} total={DEV_STARTUP_STEPS.length + 1} />
        <span fg={colors.text}>{`  ${DEV_STARTUP_STEPS[step] ?? "Starting"}…`}</span>
      </text>
      <text fg={colors.faint}>{fit(entry, width)}</text>
      <text> </text>
    </>
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
  const api = `${view.apiUrl}`
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
        <span fg={value}>{api}</span>
        <span fg={colors.faint}>{fit(extras, Math.max(0, width - 9 - api.length))}</span>
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
    <box flexDirection="column" paddingLeft={4}>
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
