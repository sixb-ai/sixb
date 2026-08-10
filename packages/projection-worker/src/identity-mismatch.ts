type IdentityMismatchCandidate = {
  readonly field: string
  readonly expected: string
  readonly actual: string
}

/** Keeps identity failures actionable without repeating every matching identity field. */
export function collectIdentityMismatches(
  candidates: readonly IdentityMismatchCandidate[]
): readonly IdentityMismatchCandidate[] {
  return candidates.filter(({ expected, actual }) => expected !== actual)
}
