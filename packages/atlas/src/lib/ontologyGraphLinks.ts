export function isMultiTypeLink(target: string | string[]): boolean {
  return target === "*" || (Array.isArray(target) && new Set(target).size > 1)
}

/** Multi-type relationships are explored from a selected target, avoiding an overview fan-out. */
export function ontologyGraphLinkTargets(
  target: string | string[],
  visibleTypeIds: ReadonlySet<string>,
  selectedTypeId: string | null
): string[] {
  const targets = target === "*" ? [...visibleTypeIds] : Array.isArray(target) ? target : [target]
  return [...new Set(targets)].filter(
    (id) => visibleTypeIds.has(id) && (!isMultiTypeLink(target) || id === selectedTypeId)
  )
}
