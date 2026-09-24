import type { SchemaOrRef, ValueType } from "../../ontology"
import { isObjectRefSchema } from "../../ontology/refs"
import { collectUserRefIds, userReferenceProblem } from "../../ontology/user-ref"
import type { AuthStorage } from "../../storage/auth/types"

/**
 * Reject params that reference a user who does not exist or is not active.
 *
 * Callers run it only when a new run is created: replaying an existing run keeps the params it was
 * accepted with, even if a referenced user was suspended since.
 */
export async function assertParamUsersActive(input: {
  readonly auth: AuthStorage | undefined
  readonly projectId: string
  readonly schemas: Readonly<Record<string, SchemaOrRef>>
  readonly values: Readonly<Record<string, unknown>>
  readonly valueTypesById: ReadonlyMap<string, ValueType>
  /** Names one param in error messages, for example `Action param 'task.assign.assignee'`. */
  readonly describe: (paramId: string) => string
  readonly invalid: (message: string) => Error
}): Promise<void> {
  const references: { readonly paramId: string; readonly id: string }[] = []
  for (const [paramId, schema] of Object.entries(input.schemas)) {
    if (isObjectRefSchema(schema)) continue
    const ids = collectUserRefIds(schema, input.values[paramId], input.valueTypesById, new Set())
    for (const id of ids) references.push({ paramId, id })
  }
  if (references.length === 0) return

  const users = input.auth?.users
  const statuses = new Map(
    await Promise.all(
      [...new Set(references.map((reference) => reference.id))].map(
        async (id) =>
          [
            id,
            users
              ? ((await users.getById({ projectId: input.projectId, id }))?.status ?? null)
              : "unverifiable",
          ] as const
      )
    )
  )
  for (const { paramId, id } of references) {
    const problem = userReferenceProblem(input.describe(paramId), id, statuses.get(id) ?? null)
    if (problem) throw input.invalid(problem)
  }
}
