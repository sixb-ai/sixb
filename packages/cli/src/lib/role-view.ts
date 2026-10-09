import type { RoleStartupPanel } from "../ui"
import { errorMessage, errorRemediation } from "./errors"

export interface RoleView {
  startup(loading: {
    readonly title: string
    readonly subtitle: string
    readonly status: string
  }): RoleStartupPanel
  error(error: unknown): Promise<void>
}

/**
 * How a long-running role reports itself: the Ink panels in a terminal, plain lines in a log.
 *
 * Ink's layout engine keeps about 45 MB for the life of the process once it is imported. `atlas`
 * and `app` run under a supervisor and serve static files, so outside a terminal they never load
 * it.
 *
 * Call this before the role sets NODE_ENV. Bun compiles JSX for the mode the process started in,
 * and React loaded after the change cannot run it: the panels then render nothing, or throw. Ink
 * stays out of logs for a second reason: its error panel could come out empty there.
 */
export async function loadRoleView(): Promise<RoleView> {
  if (process.stdout.isTTY) {
    const { renderCliError, renderRoleStartup } = await import("../ui")
    return { startup: renderRoleStartup, error: renderCliError }
  }
  return { startup: printRoleStartup, error: printRoleError }
}

function printRoleStartup(loading: {
  readonly title: string
  readonly subtitle: string
}): RoleStartupPanel {
  console.log(`${loading.title} (${loading.subtitle})`)
  return {
    started(view) {
      const items = view.items.map((item) => `${item.label} ${item.value}`).join(", ")
      console.log(`${view.title}: ${view.name}, ${view.serviceName} ${items}`)
    },
    unmount() {},
  }
}

async function printRoleError(error: unknown): Promise<void> {
  console.error(errorMessage(error))
  const remediation = errorRemediation(error)
  if (remediation) console.error(remediation)
}
