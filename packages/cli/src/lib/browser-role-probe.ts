import { spawn } from "node:child_process"
import { SixbCliError } from "./errors"
import { loadProductionSixb, type ProductionRuntimeOptions } from "./production"

/** What `atlas` and `app` need from the project to serve their prebuilt bundles. */
export interface BrowserRoleProject {
  readonly id: string
  readonly authEnabled: boolean
}

// Set only on the copy of the command that answers the probe.
const PROBE_ENV = "SIXB_BROWSER_ROLE_PROBE"
const PROVIDER_CLOSE_BOUND_MS = 5_000

export function isBrowserRoleProbe(): boolean {
  return process.env[PROBE_ENV] === "1"
}

/**
 * Reads the project's id and auth setting from a short-lived copy of this command.
 *
 * Both come from running `sixb.config.ts`, which loads every definition, connector and provider:
 * around 140 MB that a static file server would otherwise hold for as long as it runs. The copy
 * gets the same command line, environment and working directory, so it resolves the project
 * exactly as the role would have, and that memory is returned when it exits.
 */
export async function probeBrowserRoleProject(command: string): Promise<BrowserRoleProject> {
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    env: { ...process.env, [PROBE_ENV]: "1" },
    // The project's startup output and errors land in this role's log, as when it loaded in-process.
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })

  const reported: BrowserRoleProject[] = []
  child.on("message", (message: unknown) => {
    if (isBrowserRoleProject(message)) reported.push(message)
  })

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code, signal) => resolve({ code, signal }))
    }
  )

  const [project] = reported
  if (exit.code === 0 && project) {
    return project
  }

  const outcome = exit.signal ? `was stopped by ${exit.signal}` : `exited with code ${exit.code}`
  throw new SixbCliError(
    `[SixbCLI] \`sixb ${command}\` could not load the project: it ${outcome}.`,
    {
      remediation: "The error from loading the project is printed above.",
    }
  )
}

/**
 * The probe's side of {@link probeBrowserRoleProject}: loads the project, reports, and closes the
 * providers it opened. The caller exits afterwards.
 */
export async function answerBrowserRoleProbe(options: ProductionRuntimeOptions): Promise<void> {
  // The role that asked can be stopped while the project loads, and then nobody reads the answer.
  process.once("disconnect", () => process.exit(1))

  const { sixb } = await loadProductionSixb(options)
  try {
    await report({ id: sixb.id, authEnabled: sixb.auth.isEnabled() })
  } finally {
    // Imported here rather than at the top: `runtime.ts` loads every worker package, and the role
    // that spawned this probe imports this module as well.
    const { stopSixbProviders } = await import("./runtime")
    // The role waits for this process to exit before it serves, so a provider that never finishes
    // closing must not hold it. Exiting drops whatever connections are still open.
    await Promise.race([stopSixbProviders(sixb), Bun.sleep(PROVIDER_CLOSE_BOUND_MS)])
  }
}

function report(project: BrowserRoleProject): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error(`[SixbCLI] ${PROBE_ENV} is set, but no parent process is listening.`))
      return
    }
    process.send(project, (error: Error | null) => (error ? reject(error) : resolve()))
  })
}

function isBrowserRoleProject(value: unknown): value is BrowserRoleProject {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "authEnabled" in value &&
    typeof value.authEnabled === "boolean"
  )
}
