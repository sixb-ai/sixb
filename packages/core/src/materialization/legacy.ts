/**
 * Revision used while adopting effective rows written before the materializer commit ledger.
 *
 * Providers map a missing `last_commit_id` on an existing row to this value. It is never written as
 * a real commit id: the first materialized change replaces the legacy row with normal provenance.
 */
export const LEGACY_MATERIALIZER_COMMIT_ID = "__sixb_legacy_effective_state__"

export function effectiveMaterializerCommitId(lastCommitId: string | null | undefined): string {
  return lastCommitId ?? LEGACY_MATERIALIZER_COMMIT_ID
}

export function storedMaterializerCommitId(lastCommitId: string): string | null {
  return lastCommitId === LEGACY_MATERIALIZER_COMMIT_ID ? null : lastCommitId
}
