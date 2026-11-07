import { type RepublishLostRunsInput, republishLostRuns } from "../../workers/lost-runs"
import type { MaintenancePass } from "../loop"
import { recoveryPass } from "./recovery-pass"

export type RunsPassInput = Omit<RepublishLostRunsInput, "now" | "limit">

/** Brings back the runs that lost their job (see `republishLostRuns`). */
export function runsPass(input: RunsPassInput): MaintenancePass {
  return recoveryPass("runs", async () => {
    await republishLostRuns({ ...input, now: new Date() })
  })
}
