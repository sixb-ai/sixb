import { everyMs, type MaintenancePass } from "../loop"

// One pass reads the whole directory once; a provider that takes longer is hanging.
const PASS_BUDGET_MS = 10 * 60_000

/**
 * Checks the people the auth strategy signed in against its identity provider's directory, so
 * someone who leaves is suspended without waiting for an administrator (see `AuthRuntime`). A pass
 * that fails, including one that would suspend too many people at once, reaches the project's
 * error reporting on every run until it is fixed.
 */
export function directoryPass(auth: {
  readonly intervalMs: number
  checkDirectory(signal: AbortSignal): Promise<void>
}): MaintenancePass {
  return everyMs({
    id: "directory",
    intervalMs: auth.intervalMs,
    budgetMs: PASS_BUDGET_MS,
    run: (signal) => auth.checkDirectory(signal),
  })
}
