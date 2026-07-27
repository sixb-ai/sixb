import type { OntologyEditOperation } from "../../materialization/model"

export type EditExecutionUnit =
  | { readonly kind: "single"; readonly operation: OntologyEditOperation }
  | { readonly kind: "atomic-group"; readonly operations: readonly OntologyEditOperation[] }

/** Compiles validated operation groups into the exact units the executor applies. */
export function compileEditExecutionUnits(input: {
  readonly operations: readonly OntologyEditOperation[]
  readonly operationGroups?: readonly (readonly string[])[]
}): readonly EditExecutionUnit[] {
  const groupByFirstId = new Map(
    (input.operationGroups ?? []).map((ids) => [ids[0]!, new Set(ids)] as const)
  )
  const units: EditExecutionUnit[] = []

  for (let index = 0; index < input.operations.length; ) {
    const operation = input.operations[index]!
    const groupIds = groupByFirstId.get(operation.id)
    if (!groupIds) {
      units.push({ kind: "single", operation })
      index += 1
      continue
    }

    const operations = input.operations.slice(index, index + groupIds.size)
    units.push({ kind: "atomic-group", operations })
    index += operations.length
  }

  return units
}
