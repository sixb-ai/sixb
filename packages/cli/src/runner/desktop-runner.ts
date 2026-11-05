import { realpath, stat } from "node:fs/promises"
import { normalizeApiUrl } from "../lib/api-client"
import {
  type Connection,
  connect,
  profilesSignedInTo,
  type SignedOut,
  startSignInBeside,
} from "../lib/connection"
import { errorMessage } from "../lib/errors"
import { loadSettings } from "../tui/settings"
import { forgetFolderAt, setFoldersAllowed } from "./allowed-folders"
import { thisComputer } from "./computer"
import { ComputerConnection, type ComputerEvent, EXIT_SIGNED_OUT } from "./computer-connection"
import { stopInTime, stopOnHangUp } from "./local-runner"

/** How long until connecting is tried again, after the project didn't answer or anything else. */
const CONNECT_RETRY_MS = 10_000

/** What this prints, one line of JSON each. The desktop app reads them. */
export type DesktopRunnerEvent =
  | ComputerEvent
  | { readonly type: "computer"; readonly id: string; readonly name: string }
  | { readonly type: "connected" }
  | { readonly type: "signed-out-waiting" }
  | { readonly type: "sign-in"; readonly url: string; readonly userCode: string }
  | { readonly type: "sign-in-failed"; readonly message: string }
  | { readonly type: "unreachable"; readonly message: string }

/** What this reads, one line of JSON each. Only the desktop app holds the other end. */
export type DesktopRunnerCommand =
  | { readonly type: "allow"; readonly folder: string }
  | { readonly type: "forget"; readonly folder: string }

function parseCommand(line: string): DesktopRunnerCommand | null {
  try {
    const parsed = JSON.parse(line) as Partial<DesktopRunnerCommand> | null
    return (parsed?.type === "allow" || parsed?.type === "forget") &&
      typeof parsed.folder === "string"
      ? (parsed as DesktopRunnerCommand)
      : null
  } catch {
    return null
  }
}

/**
 * This computer, connected for a desktop app: `sixb connect` with no person at a terminal to ask.
 * Holding the sign-in here keeps it from the app's main process, and from the page beyond that: it
 * goes beside the CLI's, where the agent's commands can't read it, and a sign-in from `sixb login`
 * counts. It ends with its stdin, so it can't outlive the app that started it.
 */
export async function runDesktopRunner(options: {
  readonly apiUrl: string
  /** Who the person is asked to approve, in the browser. */
  readonly clientName: string
}): Promise<void> {
  const { apiUrl, clientName } = options
  const emit = (event: DesktopRunnerEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
  const { id, name } = await thisComputer()
  emit({ type: "computer", id, name })

  const { keepAwake } = await loadSettings()
  let connection: Connection | null = null
  let computer: ComputerConnection | null = null
  let signingIn = false
  let signInShown: DesktopRunnerEvent | null = null
  let signedOutNow = false
  let retry: ReturnType<typeof setTimeout> | null = null
  // What was allowed before there was a project to allow it for.
  let allowedMeanwhile: string[] = []
  let finish: (code: number) => void = () => {}
  const finished = new Promise<number>((resolve) => {
    finish = resolve
  })

  const stop = () => stopInTime(computer)
  const reportFailure = (error: unknown) => emit({ type: "error", message: errorMessage(error) })

  const allow = async (signedIn: Connection, chosen: string) => {
    // As the project keeps it, and the local sandbox compares it: its real path.
    const folder = await realpath(chosen)
    if (!(await stat(folder)).isDirectory()) throw new Error(`${folder} isn't a folder.`)
    await setFoldersAllowed(signedIn, [folder], true)
  }

  /** The first sign-in here the project still takes: one that's ended mustn't hide a newer one. */
  const firstThatConnects = async (): Promise<Connection | SignedOut> => {
    for (const profile of await profilesSignedInTo(apiUrl)) {
      const result = await connect({ profile })
      if (!("reason" in result) || result.reason === "unreachable") return result
    }
    return connect({ apiUrl })
  }

  const tryConnecting = async (): Promise<void> => {
    if (connection) return
    const result = await firstThatConnects()
    // A sign-in finishing and a retry coming due can both get here.
    if (connection) return
    if ("reason" in result) {
      if (result.reason === "unreachable") {
        emit({ type: "unreachable", message: result.message ?? `No answer from ${apiUrl}.` })
        retry = setTimeout(connectOrRetry, CONNECT_RETRY_MS)
        return
      }
      signedOutNow = true
      emit({ type: "signed-out-waiting" })
      if (allowedMeanwhile.length > 0) await signIn()
      return
    }

    signedOutNow = false
    connection = result
    emit({ type: "connected" })
    for (const folder of allowedMeanwhile.splice(0)) hear({ type: "allow", folder })

    computer = new ComputerConnection(
      result,
      (event) => {
        // Started again, this asks for a new sign-in.
        if (event.type === "signed-out") void stop().finally(() => finish(EXIT_SIGNED_OUT))
        emit(event)
      },
      keepAwake
    )
    await computer.start()
  }

  /** Whatever stopped it, such as a config it can't read, it's tried again: nothing else would. */
  const connectOrRetry = (): void => {
    void tryConnecting().catch((error: unknown) => {
      reportFailure(error)
      connection = null
      computer = null
      retry = setTimeout(connectOrRetry, CONNECT_RETRY_MS)
    })
  }

  const signIn = async (): Promise<void> => {
    if (connection) return
    if (signingIn) {
      // They closed the page, or never saw it: asking again is how they get back to it.
      if (signInShown) emit(signInShown)
      return
    }
    signingIn = true
    try {
      const pending = await startSignInBeside(apiUrl, clientName)
      signInShown = { type: "sign-in", url: pending.url, userCode: pending.userCode }
      emit(signInShown)
      await pending.complete(new AbortController().signal)
      // Not to be asked again while connecting finds that out.
      signedOutNow = false
      connectOrRetry()
    } catch (error) {
      emit({ type: "sign-in-failed", message: errorMessage(error) })
    } finally {
      signingIn = false
      signInShown = null
    }
  }

  const apply = async (command: DesktopRunnerCommand): Promise<void> => {
    if (command.type === "forget") {
      allowedMeanwhile = allowedMeanwhile.filter((folder) => folder !== command.folder)
      await forgetFolderAt(normalizeApiUrl(apiUrl), command.folder)
    } else if (connection) {
      await allow(connection, command.folder)
    } else {
      allowedMeanwhile.push(command.folder)
      if (signedOutNow) void signIn()
    }
  }

  /** One at a time, as they came: a folder allowed and then forgotten stays forgotten. */
  let commands: Promise<void> = Promise.resolve()
  const hear = (command: DesktopRunnerCommand) => {
    commands = commands.then(() => apply(command)).catch(reportFailure)
  }

  void (async () => {
    let rest = ""
    const decoder = new TextDecoder()
    for await (const chunk of Bun.stdin.stream()) {
      rest += decoder.decode(chunk, { stream: true })
      const lines = rest.split("\n")
      rest = lines.pop() ?? ""
      for (const line of lines) {
        const command = parseCommand(line)
        if (command) hear(command)
      }
    }
    // The app is gone, however it went: what it started goes too, after what it last asked for.
    if (retry) clearTimeout(retry)
    void commands.then(stop).finally(() => finish(0))
  })()

  // Ctrl+C in the terminal running `sixb dev --desktop` reaches this too. Its stdin closing, as the
  // app goes, is what ends it, with a running turn's end recorded.
  process.on("SIGINT", () => {})

  const unhook = stopOnHangUp(
    () => computer,
    (signal) => finish(signal === "SIGHUP" ? 129 : 143)
  )
  connectOrRetry()

  const code = await finished
  unhook()
  process.exit(code)
}
