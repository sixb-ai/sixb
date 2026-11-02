/** @jsxImportSource @opentui/react */
import { appendFileSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { format } from "node:util"
import { createCliRenderer, type KeyEvent, RGBA, SyntaxStyle } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useState } from "react"
import { glyph } from "../ui/theme"
import { Workspace } from "./app"
import { Logo } from "./brand"
import { thisComputerId } from "./computer"
import {
  type Connection,
  connect,
  type PendingSignIn,
  type SignedOut,
  startSignIn,
} from "./connection"
import { LocalRunner, stopOnHangUp } from "./runner"
import { loadSettings, type Settings } from "./settings"
import { type TuiColors, tuiColors } from "./theme"
import { BOLD, Composer, useSpinner } from "./ui"

/** How long quitting waits for a turn running here to record its end. */
const STOP_WAIT_MS = 10_000
/** How long quitting waits to tell the project this sixb closed: it lapses on its own anyway. */
const SESSION_CLOSE_WAIT_MS = 2_000

/** Where the app writes what would otherwise draw over it: its runner's notes and errors. */
export const TUI_LOG = join(tmpdir(), "sixb-tui.log")

/**
 * `sixb` with no command: the full-screen app. It connects as the CLI's current profile and opens
 * on a new conversation that runs in the folder it was started in.
 */
export async function runTui(options: {
  readonly version: string
  readonly apiUrl?: string
  readonly profile?: string
}): Promise<void> {
  // Read before the screen is taken, so that a failure reads as any command's.
  const computerId = await thisComputerId()
  const restoreConsole = captureConsole()
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 60,
  })
  // The tab's name while sixb has it. A terminal draws its tab's icon itself: the mark stands in.
  renderer.setTerminalTitle(`${glyph.mark} Sixb`)
  // The terminal says whether it is light or dark; SIXB_THEME decides where it can't.
  const forced = process.env.SIXB_THEME
  const mode =
    forced === "light" || forced === "dark"
      ? forced
      : await renderer.waitForThemeMode(150).catch(() => null)
  // The terminal's own colors, where it says them: the app paints over neither.
  const reported = forced
    ? null
    : await renderer
        .getPalette({ timeout: 200, size: 16 })
        .then(({ defaultBackground, defaultForeground }) =>
          defaultBackground && defaultForeground
            ? { background: defaultBackground, foreground: defaultForeground }
            : null
        )
        .catch(() => null)
  const colors = tuiColors(mode, reported)
  renderer.setBackgroundColor("transparent")
  const syntax = createSyntax(colors, renderer)
  const root = createRoot(renderer)
  // As the project keeps it, and the local sandbox compares it: its real path.
  const folder = await realpath(process.cwd())
  const settings = await loadSettings(folder)
  let runner: LocalRunner | null = null
  // The renderer gives its screen back on these signals; sixb then ends its turns and exits.
  const unhook = stopOnHangUp(
    () => runner,
    (signal) => process.exit(signal === "SIGHUP" ? 129 : 143)
  )

  try {
    await new Promise<void>((resolve) => {
      root.render(
        <App
          colors={colors}
          syntax={syntax}
          version={options.version}
          settings={settings}
          computerId={computerId}
          connectWith={(apiUrl) => connect(apiUrl ? { ...options, apiUrl } : options)}
          runnerFor={(connection) => {
            runner ??= new LocalRunner(connection, folder, (error) => console.error(error))
            return runner
          }}
          onExit={resolve}
        />
      )
    })
  } finally {
    unhook()
    root.unmount()
    // An empty title gives the tab back its own name.
    renderer.setTerminalTitle("")
    renderer.destroy()
    await renderer.closed
    syntax.destroy()
    restoreConsole()
    // A turn running here ends interrupted, its end recorded, once the terminal is back; an API
    // that stops answering gets a bounded wait, and ctrl+c ends it.
    const running = runner as LocalRunner | null
    if (running?.busy) {
      process.stderr.write("  Stopping the turn running here…\n")
      process.once("SIGINT", () => process.exit(130))
      await Promise.race([running.stop(), Bun.sleep(STOP_WAIT_MS)])
    }
    // Its conversations read as offline at once, rather than once the session lapses.
    await Promise.race([running?.closeSession(), Bun.sleep(SESSION_CLOSE_WAIT_MS)])
  }
}

function App(props: {
  readonly colors: TuiColors
  readonly syntax: SyntaxStyle
  readonly version: string
  readonly settings: Settings
  readonly computerId: string
  readonly connectWith: (apiUrl?: string) => Promise<Connection | SignedOut>
  readonly runnerFor: (connection: Connection) => LocalRunner
  readonly onExit: () => void
}) {
  const [state, setState] = useState<Connection | SignedOut | null>(null)
  const { connectWith } = props
  const reconnect = useCallback(
    (apiUrl?: string) => {
      setState(null)
      void connectWith(apiUrl).then(setState)
    },
    [connectWith]
  )
  useEffect(() => reconnect(), [reconnect])

  if (state === null) return <Splash colors={props.colors} onExit={props.onExit} />
  if ("reason" in state) {
    return (
      <Connect
        colors={props.colors}
        signedOut={state}
        onConnect={reconnect}
        onExit={props.onExit}
      />
    )
  }
  return (
    <Workspace
      connection={state}
      runner={props.runnerFor(state)}
      computerId={props.computerId}
      colors={props.colors}
      syntax={props.syntax}
      version={props.version}
      initialSettings={props.settings}
      onExit={props.onExit}
    />
  )
}

function Splash({ colors, onExit }: { readonly colors: TuiColors; readonly onExit: () => void }) {
  const spinner = useSpinner(true)
  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") onExit()
  })
  return (
    <box
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      backgroundColor={colors.background}
    >
      <Logo colors={colors} />
      <box height={2} />
      <text>
        <span fg={colors.blue}>{`${spinner} `}</span>
        <span fg={colors.muted}>Connecting</span>
      </text>
    </box>
  )
}

/** Signed out, or the project is unreachable: sign in with the browser, as `sixb login` does. */
function Connect({
  colors,
  signedOut,
  onConnect,
  onExit,
}: {
  readonly colors: TuiColors
  readonly signedOut: SignedOut
  /** Connect again, to `apiUrl` when the person gave another address. */
  readonly onConnect: (apiUrl?: string) => void
  readonly onExit: () => void
}) {
  const [pending, setPending] = useState<PendingSignIn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const spinner = useSpinner(pending !== null)
  const unreachable = signedOut.reason === "unreachable"

  const signIn = async (): Promise<void> => {
    setError(null)
    try {
      const started = await startSignIn(signedOut.apiUrl)
      setPending(started)
      await Bun.$`open ${started.url}`.quiet().nothrow()
      await started.complete(AbortSignal.timeout(10 * 60_000))
      onConnect()
    } catch (caught) {
      setPending(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  useKeyboard((key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return onExit()
    if (key.name === "escape" && pending) return setPending(null)
    if (key.name === "return" && !unreachable && !pending) void signIn()
  })

  const headline = unreachable
    ? `Sixb isn't answering at ${signedOut.apiUrl}`
    : signedOut.reason === "session-ended"
      ? "Your sign-in has ended"
      : `Sign in to ${new URL(signedOut.apiUrl).host}`
  return (
    <box
      flexGrow={1}
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      backgroundColor={colors.background}
    >
      <Logo colors={colors} />
      <box height={2} />
      <text fg={colors.text} attributes={BOLD}>
        {headline}
      </text>
      <box height={1} />
      <box width={64} flexDirection="column" alignItems="center">
        {pending ? (
          <>
            <text>
              <span fg={colors.muted}>Confirm this code in your browser </span>
              <span fg={colors.blue} attributes={BOLD}>
                {pending.userCode}
              </span>
            </text>
            <box height={1} />
            <text>
              <span fg={colors.blue}>{`${spinner} `}</span>
              <span fg={colors.muted}>Waiting for you to approve it</span>
              <span fg={colors.faint}>{"   esc cancel"}</span>
            </text>
          </>
        ) : unreachable ? (
          <>
            <text fg={colors.muted}>Start it, or connect to another address.</text>
            <box height={1} />
            <box width={64}>
              <Composer
                colors={colors}
                focused
                allowEmpty
                placeholder={signedOut.apiUrl}
                status={[{ text: "Enter to connect", color: colors.muted }]}
                onSubmit={(text) => {
                  onConnect(text || signedOut.apiUrl)
                  return true
                }}
              />
            </box>
          </>
        ) : (
          <text>
            <span fg={colors.text}>enter</span>
            <span fg={colors.muted}> sign in with your browser </span>
            <span fg={colors.text}>ctrl+c</span>
            <span fg={colors.muted}> quit</span>
          </text>
        )}
        {error ? (
          <box paddingTop={1}>
            <text fg={colors.red}>{error}</text>
          </box>
        ) : unreachable && signedOut.message ? (
          <box paddingTop={1}>
            <text fg={colors.faint}>{signedOut.message}</text>
          </box>
        ) : null}
      </box>
    </box>
  )
}

/** Markdown and code in the app's colors. */
function createSyntax(
  colors: TuiColors,
  renderer: { readonly nativeScene?: unknown }
): SyntaxStyle {
  const hex = (value: string) => RGBA.fromHex(value)
  return SyntaxStyle.fromStyles(
    {
      default: { fg: hex(colors.text) },
      "markup.heading": { fg: hex(colors.text), bold: true },
      "markup.strong": { fg: hex(colors.text), bold: true },
      "markup.italic": { fg: hex(colors.text), italic: true },
      "markup.strikethrough": { fg: hex(colors.muted) },
      "markup.quote": { fg: hex(colors.muted), italic: true },
      "markup.list": { fg: hex(colors.blue) },
      "markup.link": { fg: hex(colors.blue), underline: true },
      "markup.link.label": { fg: hex(colors.blue) },
      "markup.link.url": { fg: hex(colors.faint) },
      "markup.raw": { fg: hex(colors.code) },
      "markup.raw.block": { fg: hex(colors.text) },
      keyword: { fg: hex(colors.blue) },
      string: { fg: hex(colors.green) },
      number: { fg: hex(colors.amber) },
      comment: { fg: hex(colors.faint), italic: true },
      function: { fg: hex(colors.water[0] ?? colors.blue) },
      type: { fg: hex(colors.water[1] ?? colors.blue) },
      punctuation: { fg: hex(colors.muted) },
    },
    renderer.nativeScene as Parameters<typeof SyntaxStyle.fromStyles>[1]
  )
}

/** While the app owns the screen, what code logs goes to a file instead of over it. */
function captureConsole(): () => void {
  const methods = ["log", "info", "warn", "error", "debug"] as const
  const originals = methods.map((method) => console[method])
  for (const method of methods) {
    console[method] = (...args: unknown[]) => {
      try {
        appendFileSync(TUI_LOG, `${new Date().toISOString()} ${method} ${format(...args)}\n`)
      } catch {}
    }
  }
  // Warnings and anything else written to stderr would draw over the screen too.
  const writeError = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    try {
      appendFileSync(TUI_LOG, typeof chunk === "string" ? chunk : Buffer.from(chunk))
    } catch {}
    return true
  }) as typeof process.stderr.write
  return () => {
    methods.forEach((method, index) => {
      console[method] = originals[index] as (typeof console)[typeof method]
    })
    process.stderr.write = writeError
  }
}
