import { everyMs, type MaintenancePass } from "../loop"

// Every step is bounded, by a page count or by `intervalMs`, so only a call that hangs reaches this.
const PASS_BUDGET_MS = 5 * 60_000

export interface OntologyPassInput {
  readonly intervalMs: number
  runPass(signal: AbortSignal): Promise<void>
}

/** Catch-up and retention of what the ontology leaves behind (see `OntologyMaintenance`). */
export function ontologyPass(maintenance: OntologyPassInput): MaintenancePass {
  return everyMs({
    id: "ontology",
    intervalMs: maintenance.intervalMs,
    budgetMs: PASS_BUDGET_MS,
    run: (signal) => maintenance.runPass(signal),
  })
}
