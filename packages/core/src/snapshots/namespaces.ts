import { type BranchNamespaceStorage, isBranchNamespaceStorage } from "../storage/snapshots"
import type { Storage } from "../storage/types"

/**
 * The branch namespaces of a storage: a schema in PostgreSQL, a file in SQLite, an instance in
 * memory. A provider that cannot keep a branch apart from the rest is refused.
 */
export function branchNamespaces(storage: Storage): BranchNamespaceStorage {
  if (isBranchNamespaceStorage(storage)) return storage

  throw new Error(
    "[Sixb] This storage provider cannot isolate a branch: it has no namespace of its own to hold one. Use PostgreSQL, SQLite or in-memory storage for branches."
  )
}
