import { realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { CliError } from "@sixb/cli-core"
import { connect } from "../lib/connection"
import { readAllowedFolders, setFoldersAllowed } from "../runner/allowed-folders"
import { thisComputer } from "../runner/computer"
import { ComputerConnection, type ComputerEvent } from "../runner/computer-connection"
import { stopOnHangUp } from "../runner/local-runner"
import { shortPath } from "../tui/format"
import { glyph, tone } from "../ui/theme"

/** Exit status when the person's sign-in ended: a service manager should not just restart this. */
const EXIT_SIGNED_OUT = 3

/**
 * `sixb connect [folder...]`: keep this computer available without `sixb` open. Turns sent from
 * elsewhere to conversations in the allowed folders run here until this stops. It stays in the
 * foreground: whatever should keep it running starts it, and sees what it prints.
 */
export async function runConnect(options: {
  readonly folders: readonly string[]
  readonly yes: boolean
  readonly json: boolean
  readonly apiUrl?: string
  readonly profile?: string
}): Promise<void> {
  const connection = await connect(options)
  if ("reason" in connection) {
    throw connection.reason === "unreachable"
      ? refusal(`[SixbCLI] Sixb isn't answering at ${connection.apiUrl}.`)
      : refusal(
          `[SixbCLI] Sign in first: sixb login ${connection.apiUrl || "<api-url>"}.`,
          EXIT_SIGNED_OUT
        )
  }

  await allowFolders(options)

  const report = options.json ? printJson : printLine
  let finish: (code: number) => void = () => {}
  const finished = new Promise<number>((resolve) => {
    finish = resolve
  })
  let signedOut = false
  const computer = new ComputerConnection(connection, (event) => {
    // Every folder's session ends with the sign-in: once is enough to say so.
    if (event.type === "signed-out") {
      if (signedOut) return
      signedOut = true
      finish(EXIT_SIGNED_OUT)
    }
    report(event)
  })

  const unhook = stopOnHangUp(
    () => computer,
    (signal) => finish(signal === "SIGHUP" ? 129 : 143)
  )
  // Ctrl+C is how this is meant to stop; a second one doesn't wait for a turn to record its end.
  process.once("SIGINT", () => {
    process.once("SIGINT", () => process.exit(130))
    void computer.stop().finally(() => finish(0))
  })

  if (!options.json) {
    const { name } = await thisComputer()
    say(
      `${tone.blue(glyph.mark)} ${tone.strong(name)} ${tone.faint(`connected to ${connection.project.id}. ctrl+c to stop.`)}`
    )
  }
  await computer.start()

  const code = await finished
  unhook()
  if (signedOut) await computer.stop()
  process.exit(code)
}

/** Add what was named to the allowed folders, asking first, or offer this one if there are none. */
async function allowFolders(options: {
  readonly folders: readonly string[]
  readonly yes: boolean
  readonly json: boolean
}): Promise<void> {
  const allowed = await readAllowedFolders().catch((error: unknown) => {
    throw refusal(
      `[SixbCLI] Could not read your allowed folders. ${error instanceof Error ? error.message : ""}`
    )
  })
  const named = await Promise.all(options.folders.map(realFolder))
  // Nothing named and nothing allowed yet: this folder is the obvious one to offer.
  const offered = named.length === 0 && allowed.length === 0 ? [await realFolder(".")] : named
  const asked = [...new Set(offered)].filter((folder) => !allowed.includes(folder))

  const interactive = process.stdin.isTTY && !options.json
  if (asked.length > 0 && !options.yes && !interactive) {
    throw refusal(
      `[SixbCLI] ${asked.join(", ")} isn't allowed yet: run sixb connect in a terminal to choose it, or pass --yes.`
    )
  }
  const chosen = options.yes ? asked : await askEach(asked)
  if (chosen.length > 0) await setFoldersAllowed(chosen, true)
  if (allowed.length + chosen.length === 0) {
    throw refusal("[SixbCLI] No folders are allowed, so nothing would run here.")
  }
}

async function askEach(folders: readonly string[]): Promise<readonly string[]> {
  if (folders.length === 0) return []
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  const chosen: string[] = []
  try {
    say(
      tone.muted(
        "Messages from the web and your other devices will run in a folder you allow, on this computer, as you. The agent's commands run there without asking."
      )
    )
    for (const folder of folders) {
      const answer = await prompt.question(`Allow ${tone.strong(shown(folder))}? [y/N] `)
      if (answer.trim().toLowerCase() === "y") chosen.push(folder)
    }
  } finally {
    prompt.close()
  }
  return chosen
}

/** As the project keeps it, and the local sandbox compares it: its real path. */
async function realFolder(folder: string): Promise<string> {
  const path = resolve(folder)
  const entry = await stat(path).catch(() => null)
  if (!entry?.isDirectory()) throw refusal(`[SixbCLI] ${path} isn't a folder.`)
  return realpath(path)
}

function refusal(message: string, exitCode = 1): CliError {
  return new CliError({ code: "connect", message }, exitCode)
}

function shown(folder: string): string {
  return shortPath(folder, homedir(), 72) || folder
}

function say(line: string): void {
  process.stderr.write(`${line}\n`)
}

function printJson(event: ComputerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function printLine(event: ComputerEvent): void {
  switch (event.type) {
    case "folders":
      say(
        event.folders.length > 0
          ? `  ${tone.muted("Running messages from the web in")} ${event.folders.map(shown).join(", ")}`
          : tone.warn("  No allowed folders exist now, so nothing runs here.")
      )
      return
    case "turn.started":
      say(`  ${tone.blue(glyph.live)} ${shown(event.folder)}  ${tone.faint(event.threadId)}`)
      return
    case "turn.ended":
      say(
        `  ${event.ran ? tone.ok(glyph.ok) : tone.fail(glyph.fail)} ${shown(event.folder)}  ${tone.faint(event.threadId)}`
      )
      return
    case "session.lost":
      say(`  ${tone.warn(glyph.warn)} ${shown(event.folder)}  ${tone.muted(event.message)}`)
      return
    case "session.back":
      say(`  ${tone.ok(glyph.ok)} ${shown(event.folder)}  ${tone.muted("back online")}`)
      return
    case "signed-out":
      say(tone.fail("  Your sign-in ended. Sign in again with sixb login, then reconnect."))
      return
    case "error":
      say(`  ${tone.fail(glyph.fail)} ${tone.muted(event.message)}`)
  }
}
