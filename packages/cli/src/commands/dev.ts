import { dirname, resolve } from "node:path"
import {
  BRANCH_DATA_FROM_ENV,
  BRANCH_NAME_ENV,
  BRANCH_RUNTIME_ENV,
} from "@sixb/core/internal/runtime"
import { checkoutOf, currentGitBranch, fetchBranchCopy } from "../lib/branch-from-production"
import { connect } from "../lib/connection"
import { runDevSupervisor } from "../lib/dev-supervisor"
import { hostedBranchRuntime } from "../lib/hosted-branch"
import { resolveProfile } from "../lib/profiles"
import type { DevOptions } from "./dev-runner"
import { assertDevEnv } from "./env"

export type { DevOptions } from "./dev-runner"

export async function runDev(options: DevOptions = {}) {
  if (process.env.SIXB_DEV_CHILD === "1" && process.send) {
    // The parent cannot enforce its deadline after it dies. Arm our own before
    // importing the runner so a stuck import/startup also has a shutdown bound.
    let deadline: ReturnType<typeof setTimeout> | undefined
    const forceExit = () => {
      if (process.platform !== "win32") process.kill(-process.pid, "SIGKILL")
      else process.exit(1)
    }
    const disconnected = () => {
      deadline ??= setTimeout(forceExit, 10_000)
      process.kill(process.pid, "SIGTERM")
    }
    process.once("disconnect", disconnected)
    try {
      const { runDevRuntime } = await import("./dev-runner")
      await runDevRuntime(options)
    } finally {
      process.off("disconnect", disconnected)
      clearTimeout(deadline)
      // Graceful cleanup can finish while unowned compiler/sandbox descendants
      // remain. With no parent, this process must reap its isolated group itself.
      if (!process.connected) forceExit()
    }
    process.exit(process.exitCode ?? 0)
  }
  const root = dirname(resolve(options.entry ?? "sixb.config.ts"))
  // A branch production runs takes the `dev` values production could read, or none, and its copy
  // from production itself: its notice says what it lacks.
  const hosted = hostedBranchRuntime() !== null
  if (!hosted) await assertDevEnv(root)

  // Core reads the branch when it loads, in each child: say it before any child starts.
  if (!hosted && (options.from !== undefined || options.refresh)) {
    if (options.from !== "production") {
      throw new Error(
        "[SixbCLI] `sixb dev --from` takes `production`: a branch copies its data from production. Add --refresh to take a new copy."
      )
    }
    const gitBranch = await currentGitBranch(root)
    // Signed in as the developer here, once: the processes that run the branch's code never are.
    await fetchBranchCopy({
      projectRoot: root,
      gitBranch,
      refresh: options.refresh === true,
      profile: await profileName(),
      connect: async () => {
        const connection = await connect({})
        if (!("client" in connection)) {
          throw new Error(
            `[SixbCLI] \`sixb dev --from production\` copies production as you: sign in with \`sixb login <production api url>\` (${connection.apiUrl || "no profile"}: ${connection.reason}).`
          )
        }
        return { apiUrl: connection.apiUrl, authorization: () => connection.authorization() }
      },
    })
    process.env[BRANCH_NAME_ENV] = gitBranch
    process.env[BRANCH_DATA_FROM_ENV] = "production"
    process.env[BRANCH_RUNTIME_ENV] = await checkoutOf(root)

    // Each child inherits this environment: the branch's code gets none of the sign-in that took
    // the copy, only the branch's own credential. Blank, not deleted: each child is a new Bun
    // process, which loads `.env*` again and would fill a missing variable from `.env.local`, but
    // never one that is set. `resolveProfile` reads a blank one as unset.
    for (const name of PRODUCTION_SIGN_IN_ENV) process.env[name] = ""
  }
  await runDevSupervisor(options)
}

/** What signs the CLI in to production from the environment, as `resolveProfile` reads it. */
const PRODUCTION_SIGN_IN_ENV = ["SIXB_API_URL", "SIXB_API_TOKEN", "SIXB_TOKEN", "SIXB_PROFILE"]

/** Who the CLI is signed in as, read without the network: a copy is reused only by them. */
async function profileName(): Promise<string> {
  const profile = await resolveProfile({})
  return `${profile.profile ?? profile.tokenSource ?? "no sign-in"} at ${profile.apiUrl}`
}
