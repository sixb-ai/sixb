import { withFailureMessage } from "../errors/failure-message"
import { createSixbError, type SixbCodedError } from "../errors/internal"
import type { SixbBranch } from "./mode"

/**
 * What a branch refuses, each with the reason and what to do instead. Every gate answers with one
 * of these: nothing turned off on a branch is a silent no-op. `README.md` lists the gates.
 */
export const branchRefusals = {
  connector: (branch: SixbBranch, connectorId: string) =>
    branchRefusal(
      branch,
      `connector '${connectorId}' is not called on a branch: a branch never reaches an outside ` +
        "system. Production's data reaches it through what production ingested. Test code that " +
        "calls this connector in production, once it is merged."
    ),

  connection: (branch: SixbBranch, connectorId?: string) =>
    branchRefusal(
      branch,
      `${connectorId === undefined ? "connections" : `connections of connector '${connectorId}'`} ` +
        "cannot be connected, reauthorized or revoked on a branch: connections belong to " +
        "production. Manage them in production."
    ),

  writeback: (branch: SixbBranch, actionId: string) =>
    branchRefusal(
      branch,
      `action '${actionId}' has a writeback, which writes to a system outside Sixb, so it does ` +
        "not run on a branch. Its edits depend on the writeback's reply, so they are not applied " +
        "either. Run the action in production, or test its edits in an action without a writeback."
    ),

  sync: (branch: SixbBranch, syncId: string) =>
    branchRefusal(
      branch,
      `sync '${syncId}' does not run on a branch: a branch reads production's data as of when it ` +
        "was copied, never the source. A new or changed sync is tested in production, once merged."
    ),

  scheduledSync: (branch: SixbBranch, scheduleId: string, syncId: string) =>
    branchRefusal(
      branch,
      `schedule '${scheduleId}' starts sync '${syncId}', which does not run on a branch: a ` +
        "branch reads production's data as of when it was copied, never the source. Start what " +
        "else it runs on its own, or test the schedule in production, once merged."
    ),

  webhook: (branch: SixbBranch, connectorId: string, webhookId: string) =>
    branchRefusal(
      branch,
      `webhook '${connectorId}/${webhookId}' is not received on a branch: providers call ` +
        "production. Test it in production, once merged."
    ),

  directory: (branch: SixbBranch) =>
    branchRefusal(
      branch,
      "the directory is not checked on a branch: checking it suspends people. Production checks it."
    ),

  email: (branch: SixbBranch, what: "invitation" | "sign-in link") =>
    branchRefusal(
      branch,
      `no ${what} is emailed from a branch: its members are production's people. Invite people ` +
        "in production; on a branch you are signed in through production."
    ),
} as const

/** A coded refusal whose message, the whole explanation, reaches the caller and the run's record. */
export function branchRefusal(branch: SixbBranch, explanation: string): SixbCodedError {
  const message = `[Sixb] Branch "${branch.name}": ${explanation}`
  const error = createSixbError("branch.refused", message, { details: { branch: branch.name } })

  return withFailureMessage(error, message)
}
