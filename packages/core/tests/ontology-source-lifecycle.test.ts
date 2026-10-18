import { describe, expect, test } from "bun:test"
import type { ProjectionExecution } from "../src/materialization/model"
import {
  createInMemoryOntologyState,
  sourceMaterializationKey,
} from "../src/storage/ontology/in-memory/shared-state"
import { InMemoryOntologySourceStorage } from "../src/storage/ontology/in-memory/sources"
import type {
  BeginSourceMaterializationInput,
  StageSourceAssertion,
} from "../src/storage/ontology/sources"

const projectId = "project"
const source = { projectionId: "devices" } as const
const datasetVersion = {
  datasetId: "devices",
  versionId: "version-1",
  createdAt: "2026-01-01T00:00:00.000Z",
} as const

function fixture() {
  const state = createInMemoryOntologyState()
  const currentTokens = new Map<string, string>()
  const storage = new InMemoryOntologySourceStorage(
    state,
    async (run) => await run(),
    ({ source: fencedSource, execution }) => {
      if (fencedSource.projectionId !== source.projectionId) {
        throw new Error("projection identity mismatch")
      }
      if (currentTokens.get(execution.projectionRunId) !== execution.executionToken) {
        throw new Error("execution lost")
      }
    }
  )
  const claim = (projectionRunId: string, executionToken: string): ProjectionExecution => {
    currentTokens.set(projectionRunId, executionToken)
    return { projectionRunId, executionToken }
  }
  return { state, storage, claim }
}

function beginInput(
  materializationId: string,
  execution: ProjectionExecution,
  createdAt = "2026-02-01T00:00:00.000Z"
): BeginSourceMaterializationInput {
  return {
    projectId,
    source,
    materializationId,
    execution,
    projectionKind: "object",
    protocol: "replacement",
    datasetVersion,
    projectionRevision: "projection-revision",
    ownershipHash: "ownership-hash",
    ontologyRevision: "ontology-revision",
    createdAt,
  }
}

function objectRow(id: string, stagingOrdinal: number): StageSourceAssertion {
  const ref = { objectTypeId: "Device", primaryId: id }
  return {
    root: { kind: "object", ref },
    assertion: { kind: "object", ref, properties: { name: id } },
    stagingOrdinal,
  }
}

function linkRow(stagingOrdinal: number): StageSourceAssertion {
  const ref = {
    source: { objectTypeId: "Device", primaryId: "one" },
    linkId: "parent",
    target: { objectTypeId: "Device", primaryId: "two" },
  }
  return {
    root: { kind: "link", ref },
    assertion: { kind: "link", ref },
    stagingOrdinal,
  }
}

describe("in-memory ontology source lifecycle", () => {
  test("pins projection kind and rejects rows from another projection lane", async () => {
    const { storage, claim } = fixture()
    const execution = claim("run-link", "token-link")
    const input = {
      ...beginInput("materialization-link", execution),
      projectionKind: "link" as const,
    }
    expect(await storage.beginMaterialization(input)).toMatchObject({
      projectionKind: "link",
      protocol: "replacement",
    })
    await expect(
      storage.stageRows({
        projectId,
        source,
        materializationId: input.materializationId,
        execution,
        rows: [objectRow("one", 0)],
      })
    ).rejects.toThrow("Link projection source rows")
    expect(
      await storage.stageRows({
        projectId,
        source,
        materializationId: input.materializationId,
        execution,
        rows: [linkRow(0)],
      })
    ).toEqual({ inserted: 1, unchanged: 0 })
  })

  test("seals only roots with their exact normalized assertion topology", async () => {
    const { storage, claim } = fixture()
    const objectExecution = claim("topology-object-run", "topology-object-token")
    const objectMaterializationId = "topology-object"
    await storage.beginMaterialization(beginInput(objectMaterializationId, objectExecution))
    const root = objectRow("one", 0)
    await storage.stageRows({
      projectId,
      source,
      materializationId: objectMaterializationId,
      execution: objectExecution,
      rows: [
        root,
        {
          root: root.root,
          assertion: {
            kind: "link",
            ref: {
              source: { objectTypeId: "Device", primaryId: "other" },
              linkId: "parent",
              target: { objectTypeId: "Device", primaryId: "one" },
            },
          },
          stagingOrdinal: 0,
        },
      ],
    })
    await expect(
      storage.markReady({
        projectId,
        source,
        materializationId: objectMaterializationId,
        execution: objectExecution,
        rootCount: 1,
        assertionCount: 2,
        readyAt: "2026-02-01T00:01:00.000Z",
      })
    ).rejects.toThrow("links sourced from that root")

    const linkExecution = claim("topology-link-run", "topology-link-token")
    const linkMaterializationId = "topology-link"
    await storage.beginMaterialization({
      ...beginInput(linkMaterializationId, linkExecution),
      projectionKind: "link",
    })
    const link = linkRow(0)
    if (link.assertion.kind !== "link") throw new Error("Expected link fixture")
    await storage.stageRows({
      projectId,
      source,
      materializationId: linkMaterializationId,
      execution: linkExecution,
      rows: [
        {
          ...link,
          assertion: {
            kind: "link",
            ref: {
              ...link.assertion.ref,
              target: { objectTypeId: "Device", primaryId: "other" },
            },
          },
        },
      ],
    })
    await expect(
      storage.markReady({
        projectId,
        source,
        materializationId: linkMaterializationId,
        execution: linkExecution,
        rootCount: 1,
        assertionCount: 1,
        readyAt: "2026-02-01T00:01:00.000Z",
      })
    ).rejects.toThrow("matching link assertion")
  })

  test("purges abandoned candidates whole, oldest first, rows before their manifest", async () => {
    const { state, storage, claim } = fixture()
    const execution = claim("cleanup-run", "cleanup-token")
    const materializationId = "cleanup-with-rows"
    await storage.beginMaterialization(
      beginInput(materializationId, execution, "2026-01-01T00:00:00.000Z")
    )
    await storage.stageRows({
      projectId,
      source,
      materializationId,
      execution,
      rows: [objectRow("one", 0), objectRow("two", 1)],
    })
    await storage.abandon({
      kind: "candidate",
      projectId,
      source,
      materializationId,
      execution,
      abandonedAt: "2026-01-02T00:00:00.000Z",
    })

    const emptyExecution = claim("cleanup-empty-run", "cleanup-empty-token")
    await storage.beginMaterialization(
      beginInput("cleanup-empty", emptyExecution, "2026-01-01T00:00:00.000Z")
    )
    await storage.abandon({
      kind: "candidate",
      projectId,
      source,
      materializationId: "cleanup-empty",
      execution: emptyExecution,
      abandonedAt: "2026-01-03T00:00:00.000Z",
    })

    const liveExecution = claim("cleanup-live-run", "cleanup-live-token")
    await storage.beginMaterialization(
      beginInput("cleanup-live", liveExecution, "2025-01-01T00:00:00.000Z")
    )
    await storage.markReady({
      projectId,
      source,
      materializationId: "cleanup-live",
      execution: liveExecution,
      rootCount: 0,
      assertionCount: 0,
      readyAt: "2025-01-01T00:01:00.000Z",
    })
    const liveKey = sourceMaterializationKey(projectId, source.projectionId, "cleanup-live")
    const readyLive = state.sourceMaterializations.get(liveKey)
    if (!readyLive) throw new Error("expected ready source materialization")
    state.activeSourceHeads.set(JSON.stringify([projectId, source.projectionId]), "cleanup-live")
    state.sourceMaterializations.set(liveKey, {
      ...readyLive,
      status: "active",
      executionToken: null,
      activatedAt: "2025-01-01T00:02:00.000Z",
      lastCommitId: "cleanup-live-commit",
      updatedAt: "2025-01-01T00:02:00.000Z",
    })

    // Retention applies to superseded versions only: nothing reads an abandoned candidate.
    expect(
      await storage.cleanupTerminal({
        projectId,
        terminalBefore: "2026-02-01T00:00:00.000Z",
        limit: 10,
      })
    ).toEqual({ rowsDeleted: 0, materializationsDeleted: 0 })
    expect(await storage.purgeAbandoned({ projectId, limit: 2 })).toEqual({
      rowsDeleted: 2,
      materializationsDeleted: 0,
    })
    expect(
      state.sourceMaterializations.has(
        sourceMaterializationKey(projectId, source.projectionId, materializationId)
      )
    ).toBe(true)
    const partiallyCleaned = state.sourceMaterializations.get(
      sourceMaterializationKey(projectId, source.projectionId, materializationId)
    )
    expect(partiallyCleaned?.rootOrdinals.size).toBe(0)
    expect(partiallyCleaned?.ordinalRoots.size).toBe(0)
    expect(await storage.purgeAbandoned({ projectId, limit: 2 })).toEqual({
      rowsDeleted: 2,
      materializationsDeleted: 0,
    })
    expect(await storage.purgeAbandoned({ projectId, limit: 1 })).toEqual({
      rowsDeleted: 0,
      materializationsDeleted: 1,
    })
    expect(await storage.purgeAbandoned({ projectId, limit: 10 })).toEqual({
      rowsDeleted: 0,
      materializationsDeleted: 1,
    })
    expect(await storage.purgeAbandoned({ projectId, limit: 10 })).toEqual({
      rowsDeleted: 0,
      materializationsDeleted: 0,
    })
    expect(state.sourceMaterializations.has(liveKey)).toBe(true)
    expect(await storage.getActive({ projectId, source })).toMatchObject({
      materializationId: "cleanup-live",
      status: "active",
    })
  })
})
