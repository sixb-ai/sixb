import { realpath, stat } from "node:fs/promises"
import { normalizeApiUrl } from "../lib/api-client"
import {
  type Connection,
  connect,
  profilesSignedInTo,
  type SignedOut,
  startSignInBeside,
} from "../lib/connection"
import { loadSettings } from "../tui/settings"
import { forgetFolderAt, setFoldersAllowed } from "./allowed-folders"
import { thisComputer } from "./computer"
import { ComputerConnection, type ComputerEvent } from "./computer-connection"
import { stopOnHangUp } from "./local-runner"

/** Exit status when the sign-in ended: the desktop app starts this again, which asks for a new one. */
const EXIT_SIGNED_OUT = 3
/** How long stopping waits for a running turn to record its end, or the project to answer. */
const STOP_WAIT_MS = 10_000
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

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
  const emit = (event: DesktopRunnerEvent) => process.stdout.write(`${JSON.stringify(event)}\n`)
  const { id, name } = await thisComputer()
  emit({ type: "computer", id, name })

  const { keepAwake } = await loadSettings()
  let connection: Connection | null = null
  let computer: ComputerConnection | null = null
  let signingIn = false
  let signedOutNow = false
  let retry: ReturnType<typeof setTimeout> | null = null
  // What was allowed before there was a project to allow it for.
  let allowedMeanwhile: readonly string[] = []
  let finish: (code: number) => void = () => {}
  const finished = new Promise<number>((resolve) => {
    finish = resolve
  })

  const stopInTime = () => Promise.race([computer?.stop(), Bun.sleep(STOP_WAIT_MS)])
  const reportFailure = (error: unknown) => emit({ type: "error", message: messageOf(error) })

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
    const chosen = allowedMeanwhile
    allowedMeanwhile = []
    for (const folder of chosen) await allow(result, folder).catch(reportFailure)

    let signedOut = false
    computer = new ComputerConnection(
      result,
      (event) => {
        // Every folder's session ends with the sign-in: once is enough to say so.
        if (event.type === "signed-out") {
          if (signedOut) return
          signedOut = true
          void stopInTime().finally(() => finish(EXIT_SIGNED_OUT))
        }
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
    if (connection || signingIn) return
    signingIn = true
    try {
      const pending = await startSignInBeside(apiUrl, clientName)
      emit({ type: "sign-in", url: pending.url, userCode: pending.userCode })
      await pending.complete(new AbortController().signal)
      signingIn = false
      connectOrRetry()
    } catch (error) {
      signingIn = false
      emit({ type: "sign-in-failed", message: messageOf(error) })
    }
  }

  const hear = (command: DesktopRunnerCommand) => {
    if (command.type === "forget") {
      allowedMeanwhile = allowedMeanwhile.filter((folder) => folder !== command.folder)
      void forgetFolderAt(normalizeApiUrl(apiUrl), command.folder).catch(reportFailure)
      return
    }
    if (connection) {
      void allow(connection, command.folder).catch(reportFailure)
      return
    }
    allowedMeanwhile = [...allowedMeanwhile, command.folder]
    if (signedOutNow) void signIn()
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
    // The app is gone, however it went: what it started goes too.
    if (retry) clearTimeout(retry)
    void stopInTime().finally(() => finish(0))
  })()

  const unhook = stopOnHangUp(
    () => computer,
    (signal) => finish(signal === "SIGHUP" ? 129 : 143)
  )
  connectOrRetry()

  const code = await finished
  unhook()
  process.exit(code)
}
