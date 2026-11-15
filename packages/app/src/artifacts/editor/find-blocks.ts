/** The kinds of block a query finds, best first: by label, then by keyword. */
export function findBlockTypes<
  Type extends { readonly label: string; readonly keywords: readonly string[] },
>(types: readonly Type[], query: string): Type[] {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return [...types]
  const score = (type: Type) => {
    const label = type.label.toLowerCase()
    if (label.startsWith(wanted)) return 0
    if (label.includes(wanted)) return 1
    if (type.keywords.some((keyword) => keyword.startsWith(wanted))) return 2
    return -1
  }
  return types
    .map((type) => ({ type, rank: score(type) }))
    .filter(({ rank }) => rank >= 0)
    .sort((left, right) => left.rank - right.rank)
    .map(({ type }) => type)
}
