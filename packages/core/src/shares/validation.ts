import type { ActionDefinitionCatalog } from "../actions"
import type { OntologyDefinitionCatalog } from "../ontology"
import { snapshotShareDefinition } from "./builders"
import { compileShareAccessPlan } from "./compiler"
import { ShareDefinitionError } from "./errors"
import type { ShareDefinition } from "./types"

/** Cross-validate discovered Share definitions after ontology and Actions are registered. */
export function validateSharesAtStartup(input: {
  readonly shares: readonly ShareDefinition[]
  readonly ontology: OntologyDefinitionCatalog
  readonly actions: ActionDefinitionCatalog
}): ReadonlyMap<string, ShareDefinition> {
  const byId = new Map<string, ShareDefinition>()
  for (const authoredShare of input.shares) {
    const share = snapshotShareDefinition(authoredShare)
    if (byId.has(share.id)) {
      throw invalid(`Duplicate Share id: ${share.id}`)
    }
    compileShareAccessPlan({
      share,
      target: {
        objectTypeId: share.target.objectTypeId,
        primaryId: "__sixb_share_definition_validation__",
      },
      ontology: input.ontology,
      actions: input.actions,
    })
    byId.set(share.id, share)
  }
  return byId
}

export function assertShareDefinitionEnvelope(value: unknown): asserts value is ShareDefinition {
  snapshotShareDefinition(value)
}

function invalid(message: string): ShareDefinitionError {
  return new ShareDefinitionError(`[Sixb] ${message}`)
}
