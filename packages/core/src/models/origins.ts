/**
 * Where the model providers this process made send their requests, by provider id. A branch
 * production runs reaches only what its sandbox allows: production lets it reach the providers
 * the project's models use. A provider that does not say where it calls is reached only through
 * what the deployment allows (`SIXB_BRANCH_ALLOW`).
 */
const origins = new Map<string, Set<string>>()

/** A provider says, when it is made, where its requests go: one of its URLs. */
export function registerModelOrigin(providerId: string, url: string): void {
  const origin = new URL(url).origin
  const known = origins.get(providerId) ?? new Set<string>()
  known.add(origin)
  origins.set(providerId, known)
}

/** The origins the models a catalog holds are called at, as their providers said. */
export function modelOriginsOf(catalog: unknown): readonly string[] {
  const found = new Set<string>()
  for (const providerId of providerIdsIn(catalog, 0)) {
    for (const origin of origins.get(providerId) ?? []) found.add(origin)
  }
  return [...found].sort()
}

/** Every `providerId` in a catalog: its models, in lists, tiers or bindings. */
function providerIdsIn(value: unknown, depth: number): Set<string> {
  const ids = new Set<string>()
  if (depth > 5 || value === null || typeof value !== "object") return ids
  const record = value as Record<string, unknown>
  if (typeof record.providerId === "string") ids.add(record.providerId)

  const children = Array.isArray(value) ? value : Object.values(record)
  for (const child of children) {
    for (const id of providerIdsIn(child, depth + 1)) ids.add(id)
  }
  return ids
}
