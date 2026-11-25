import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { isAllowed } from "../authorization/decision"
import { AuthorizationError } from "../authorization/errors"
import type { AuthorizationContext } from "../authorization/types"
import { dropLakeSlice } from "../datasets/lake-slices"
import { createPrincipalRequestScope } from "../execution/scopes"
import type { AuthorizationRef } from "../execution/types"
import type { SixbHostView } from "../runtime/host"
import { exportSnapshot, hostSnapshotSource, type SnapshotLakeSlice } from "../snapshots/export"
import { newBranchCredential } from "./credential"
import { encodeBranchCopyPart } from "./wire"

export interface CopyForBranchInput {
  /** The person the copy is taken as: everything they read, nothing more. */
  readonly person: AuthorizationContext
  /** The git branch the copy is for, as `sixb dev --from production` names it. */
  readonly branch: string
  readonly requestId: string
  /** Where production writes the lake slice's catalog for the time of the copy. */
  readonly directory: string
  /** The credential the person signed in with, as their request's scope records it. */
  readonly credential?: Extract<AuthorizationRef, { readonly type: "principal" }>["credential"]
}

/** Catalog bytes per part: a catalog is a few megabytes, even at 100M rows. */
const CATALOG_PART_BYTES = 4 * 1024 * 1024

/**
 * What `sixb dev --from production` takes from production, as one person reads it, at one moment:
 * the snapshot of objects, then, when production's lake can be branched, the slice of its datasets
 * cut inside the same read and the first token that reads it (see `wire.ts`).
 *
 * Copying takes `can.manage(project.source)`: branch code can widen what its creator's copy shows.
 */
export async function* copyForBranch(
  host: SixbHostView,
  input: CopyForBranchInput
): AsyncGenerator<Uint8Array> {
  const principal = input.person.principal
  if (principal.type !== "user") {
    throw new Error("[Sixb] A branch copies what one person reads: sign in as a person.")
  }
  if (!isAllowed(input.person, { kind: "source.manage" })) {
    throw new AuthorizationError(
      "manage:source",
      `[Sixb] '${principal.id}' cannot copy production's data to a branch: it takes can.manage(project.source).`
    )
  }

  const scope = createPrincipalRequestScope({
    projectId: host.id,
    requestId: input.requestId,
    correlationId: input.requestId,
    context: input.person,
    ...(input.credential ? { credential: input.credential } : {}),
  })
  const branchesLake = host.lakeStorage.forks !== undefined && host.storage.lakeSlices !== undefined
  const catalogPath = join(input.directory, `branch-copy-${randomUUID()}.ducklake`)
  const branchCredential = newBranchCredential()
  let slice: SnapshotLakeSlice | undefined
  let complete = false

  // Recorded as it starts, so a copy cut short shows too: in the log with its branch, and in
  // the person's activity, which keeps no value such as a branch's name.
  console.info(
    `[Sixb] ${principal.id} is copying what they can read to branch ${JSON.stringify(input.branch)}.`
  )
  if (input.credential?.type === "session") {
    await host.activity.capture(
      { actor: { type: "user", userId: principal.id }, sessionId: input.credential.id },
      [
        {
          id: `branch_copy_${randomUUID()}`,
          type: "ui.interaction",
          name: "branch.copy",
          route: "/branches",
        },
      ]
    )
  }

  try {
    for await (const chunk of exportSnapshot(hostSnapshotSource(host), {
      scope,
      ...(branchesLake
        ? {
            lake: {
              path: catalogPath,
              branch: input.branch,
              credentialHash: branchCredential.hash,
              onSlice: (cut: SnapshotLakeSlice) => {
                slice = cut
              },
            },
          }
        : {}),
    })) {
      yield encodeBranchCopyPart("snapshot", chunk)
    }

    if (slice) {
      const catalog = new Uint8Array(await Bun.file(catalogPath).arrayBuffer())
      for (let start = 0; start < catalog.length; start += CATALOG_PART_BYTES) {
        yield encodeBranchCopyPart("catalog", catalog.subarray(start, start + CATALOG_PART_BYTES))
      }
      yield encodeBranchCopyPart("lake", {
        sliceId: slice.slice.id,
        point: slice.slice.point,
        token: slice.token.token,
        expiresAt: slice.token.expiresAt.toISOString(),
        credential: branchCredential.credential,
      })
    }
    yield encodeBranchCopyPart("end")
    complete = true
  } finally {
    await rm(catalogPath, { force: true })
    await rm(`${catalogPath}.wal`, { force: true })

    // A copy the branch did not receive whole leaves no slice holding production's files.
    if (!complete && slice) await dropLakeSlice(host, slice.slice.id)
    console.info(
      `[Sixb] ${principal.id}'s copy to branch ${JSON.stringify(input.branch)} ${complete ? "is complete" : "did not complete"}.`
    )
  }
}
