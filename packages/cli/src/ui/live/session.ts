import { format } from "node:util"
import { type CliRenderer, createCliRenderer, TextRenderable } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type { ReactNode } from "react"
import { palette } from "../theme"
import { ansiToStyledText } from "./ansi"

/**
 * The live screens draw a footer pinned to the bottom of the terminal while output scrolls above
 * it (OpenTUI's split-footer mode). Nothing leaves the main screen: when the footer goes, what
 * scrolled past stays in the scrollback like any other command's output.
 */

export interface LiveColors {
  /** The terminal's own foreground, guessed from its background; OpenTUI needs a color. */
  readonly text: string
  readonly blue: string
  readonly water: readonly string[]
  readonly green: string
  readonly amber: string
  readonly red: string
  readonly muted: string
  readonly faint: string
}

export interface Footer {
  readonly colors: LiveColors
  readonly renderer: CliRenderer
  render(node: ReactNode): void
  /** Writes text, which may carry SGR colors, into the scrollback above the footer. */
  print(text: string): void
  /** How many rows the footer takes; it never takes more than the terminal has. */
  resize(rows: number): void
  /** Removes the footer and gives the terminal back. */
  stop(): Promise<void>
}

export async function startFooter(options: { readonly rows: number }): Promise<Footer> {
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: options.rows,
    externalOutputMode: "capture-stdout",
    exitOnCtrlC: false,
    clearOnShutdown: true,
  })
  const mode = await renderer.waitForThemeMode(150).catch(() => null)
  const colors: LiveColors = {
    ...palette,
    text: mode === "light" ? "#17181c" : "#eceef2",
  }
  const root = createRoot(renderer)

  const print = (text: string) => {
    const body = text.replace(/\n+$/, "")
    if (renderer.isDestroyed) {
      process.stdout.write(`${body}\n`)
      return
    }
    renderer.writeToScrollback((context) => {
      const height = body
        .split("\n")
        .reduce(
          (rows, line) =>
            rows + Math.max(1, Math.ceil(Bun.stringWidth(line) / Math.max(1, context.width))),
          0
        )
      const node = new TextRenderable(context.renderContext, {
        content: ansiToStyledText(body, colors.text),
        width: context.width,
        height,
        wrapMode: "char",
      })
      return {
        root: node,
        width: context.width,
        height,
        startOnNewLine: true,
        trailingNewline: true,
      }
    })
  }

  // Bun's console writes past `process.stdout.write`, so it would draw over the footer.
  const methods = ["log", "info", "warn", "error", "debug"] as const
  const originals = methods.map((method) => console[method])
  for (const method of methods) {
    console[method] = (...args: unknown[]) => print(format(...args))
  }

  let stopped: Promise<void> | null = null
  return {
    colors,
    renderer,
    render: (node) => root.render(node),
    print,
    resize(rows) {
      renderer.footerHeight = Math.max(1, Math.min(rows, renderer.terminalHeight - 1))
    },
    stop() {
      stopped ??= (async () => {
        methods.forEach((method, index) => {
          console[method] = originals[index] as (typeof console)[typeof method]
        })
        root.unmount()
        renderer.destroy()
        // What prints next would race the footer being cleared without this.
        await renderer.closed
      })()
      return stopped
    },
  }
}
