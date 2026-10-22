/** @jsxImportSource @opentui/react */
import type { KeyEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useSyncExternalStore } from "react"
import { header } from "../layout"
import { glyph, tone } from "../theme"
import { BOLD, Tiles, useSpinner, useTick } from "./components"
import { type LiveColors, startFooter } from "./session"

export interface DeployProgressHeader {
  readonly name: string
  readonly location: string
  readonly commit: string
  readonly ref: string
  readonly dirty: boolean
}

interface ProgressState {
  readonly labels: readonly string[]
  readonly done: number
  readonly current: number | null
  readonly startedAt: number
  /** When the deploy itself began, for its running total. */
  readonly deployStartedAt: number
  readonly output: readonly string[]
}

export interface LiveDeployProgress {
  steps(labels: readonly string[]): void
  running(index: number): void
  done(index: number, seconds: string): void
  output(line: string): void
  /** Marks the step that failed, then leaves `report` (the error screen) in the scrollback. */
  failed(index: number | null, seconds: string | null, report: string): Promise<void>
  finished(report: string): Promise<void>
}

const OUTPUT_ROWS = 6

/**
 * A deploy in a terminal. Finished steps land in the scrollback as they finish; the footer holds
 * the step running now, the mosaic filling toward done, and that step's latest output.
 */
export async function startLiveDeploy(release: DeployProgressHeader): Promise<LiveDeployProgress> {
  const footer = await startFooter({ rows: OUTPUT_ROWS + 2 })
  let state: ProgressState = {
    labels: [],
    done: 0,
    current: null,
    startedAt: Date.now(),
    deployStartedAt: Date.now(),
    output: [],
  }
  const listeners = new Set<() => void>()
  const set = (next: Partial<ProgressState>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }
  const store = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => state,
  }

  footer.print(
    [
      "",
      `  ${header("deploy", `${release.name} ${glyph.arrow} ${release.location}`)}`,
      `  ${tone.muted(`${release.commit.slice(0, 12)} ${glyph.dot} ${release.ref}`)}`,
      ...(release.dirty
        ? [`  ${tone.warn(`${glyph.warn} Uncommitted changes are not deployed.`)}`]
        : []),
      // A space, not "": the scrollback drops trailing empty lines.
      " ",
    ].join("\n")
  )
  // Raw mode turns ctrl+c into a key. It still ends the command, once the terminal is given back.
  const interrupt = () => void footer.stop().then(() => process.exit(130))
  footer.render(<DeployFooter store={store} colors={footer.colors} onInterrupt={interrupt} />)

  return {
    steps(labels) {
      set({ labels: [...labels] })
    },
    running(index) {
      set({ current: index, startedAt: Date.now(), output: [] })
    },
    done(index, seconds) {
      // Steps line up, and so do their times, right-aligned in a column.
      footer.print(`  ${tone.ok(glyph.ok)} ${stepLine(state.labels, index, seconds)}`)
      set({ done: index + 1 })
    },
    output(line) {
      set({ output: [...state.output, line].slice(-OUTPUT_ROWS) })
    },
    async failed(index, seconds, report) {
      if (index !== null) {
        footer.print(
          `  ${tone.fail(glyph.fail)} ${stepLine(state.labels, index, seconds, tone.fail)}`
        )
      }
      footer.print(report)
      await footer.stop()
    },
    async finished(report) {
      footer.print(report)
      await footer.stop()
    },
  }
}

/** A finished step: its label padded to the longest one, then its time, right-aligned. */
function stepLine(
  labels: readonly string[],
  index: number,
  seconds: string | null,
  style: (text: string) => string = (text) => text
): string {
  const width = Math.max(0, ...labels.map((label) => label.length)) + 2
  const label = labels[index] ?? ""
  return `${style(label.padEnd(width))}${seconds ? tone.faint(`${seconds}s`.padStart(6)) : ""}`
}

function DeployFooter({
  store,
  colors,
  onInterrupt,
}: {
  readonly store: { subscribe(listener: () => void): () => void; get(): ProgressState }
  readonly colors: LiveColors
  readonly onInterrupt: () => void
}) {
  const state = useSyncExternalStore(store.subscribe, store.get)
  const spinner = useSpinner()
  const now = useTick(100)
  const { width } = useTerminalDimensions()

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") onInterrupt()
  })

  const label = state.current === null ? "Connecting" : (state.labels[state.current] ?? "")
  const elapsed = ((now - state.startedAt) / 1000).toFixed(1)
  const total = ((now - state.deployStartedAt) / 1000).toFixed(1)
  const lineWidth = Math.max(10, width - 8)
  return (
    <box flexDirection="column" paddingLeft={2}>
      <text>
        <Tiles colors={colors} filled={state.done} total={Math.max(1, state.labels.length)} />
        <span fg={colors.muted}>{`  ${state.done}/${state.labels.length || "?"}   `}</span>
        <span fg={colors.blue}>{spinner}</span>
        <span fg={colors.text} attributes={BOLD}>{` ${label}`}</span>
        <span fg={colors.faint}>{`  ${elapsed}s`}</span>
        <span fg={colors.faint}>{`   ${glyph.dot}   ${total}s total`}</span>
      </text>
      <box flexDirection="column" paddingLeft={2} paddingTop={1} height={OUTPUT_ROWS}>
        {state.output.map((line, index) => (
          <text key={`${index}:${line}`}>
            <span fg={colors.faint}>{`${glyph.rule} `}</span>
            <span fg={colors.muted}>
              {line.length > lineWidth ? `${line.slice(0, lineWidth - 1)}…` : line}
            </span>
          </text>
        ))}
      </box>
    </box>
  )
}
