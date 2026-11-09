import { everyMs, type MaintenancePass } from "../loop"

/** How often the passes that repair what the event path can lose look. */
export const RECOVERY_INTERVAL_MS = 30_000

// A first run looks every dataset up, and later ones read what changed: only a hung call gets here.
const RECOVERY_BUDGET_MS = 5 * 60_000

/** A pass that repairs what the event path can lose: every one of them keeps this rhythm. */
export function recoveryPass(id: string, run: (signal: AbortSignal) => Promise<void>) {
  return everyMs({
    id,
    intervalMs: RECOVERY_INTERVAL_MS,
    budgetMs: RECOVERY_BUDGET_MS,
    run,
  }) satisfies MaintenancePass
}
