/**
 * The nearest of an execution and its ancestors that `isOwner` accepts, walking up through
 * `parentOf`: where a roll-up counts what the execution spent. Undefined when the walk runs out of
 * known parents first.
 */
export function nearestOwner(
  executionId: string,
  parentOf: (executionId: string) => string | undefined,
  isOwner: (executionId: string) => boolean
): string | undefined {
  let current: string | undefined = executionId
  while (current !== undefined && !isOwner(current)) current = parentOf(current)
  return current
}
