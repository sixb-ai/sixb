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
  test("represents and seals an empty materialization without sentinel rows", async () => {
    const { state, storage, claim } = fixture()
    const execution = claim("run-empty", "token-empty")
    const input = beginInput("materialization-empty", execution)

    const staging = await storage.beginMaterialization(input)
    expect(staging).toMatchObject({
      projectionKind: "object",
      protocol: "replacement",
      status: "staging",
      executionToken: "token-empty",
      rootCount: null,
      assertionCount: null,
      readyAt: null,
    })
    expect(await storage.beginMaterialization(input)).toEqual(staging)
    expect(await storage.getActive({ projectId, source })).toBeNull()

    const readyInput = {
      projectId,
      source,
      materializationId: input.materializationId,
      execution,
      rootCount: 0,
      assertionCount: 0,
      readyAt: "2026-02-01T00:01:00.000Z",
    } as const
    const ready = await storage.markReady(readyInput)
    expect(ready).toMatchObject({
      status: "ready",
      executionToken: "token-empty",
      rootCount: 0,
      assertionCount: 0,
      readyAt: readyInput.readyAt,
    })
    expect(await storage.markReady(readyInput)).toEqual(ready)
    expect(
      state.sourceMaterializations.get(
        sourceMaterializationKey(projectId, source.projectionId, input.materializationId)
      )?.rowsByEntity.size
    ).toBe(0)
    await expect(
      storage.stageRows({
        projectId,
        source,
        materializationId: input.materializationId,
        execution,
        rows: [],
      })
    ).rejects.toThrow("cannot accept rows")
  })

  test("stages atomically, restages exact rows idempotently, and verifies ready counts", async () => {
    const { state, storage, claim } = fixture()
    const execution = claim("run-rows", "token-rows")
    const materializationId = "materialization-rows"
    await storage.beginMaterialization(beginInput(materializationId, execution))

    const first = objectRow("one", 0)
    expect(
      await storage.stageRows({ projectId, source, materializationId, execution, rows: [first] })
    ).toEqual({ inserted: 1, unchanged: 0 })
    expect(
      await storage.stageRows({ projectId, source, materializationId, execution, rows: [first] })
    ).toEqual({ inserted: 0, unchanged: 1 })

    await expect(
      storage.stageRows({
        projectId,
        source,
        materializationId,
        execution,
        rows: [objectRow("two", 1), objectRow("three", 1)],
      })
    ).rejects.toThrow("ordinal 1")
    const stored = state.sourceMaterializations.get(
      sourceMaterializationKey(projectId, source.projectionId, materializationId)
    )
    expect(stored?.rowsByEntity.size).toBe(1)

    await storage.stageRows({
      projectId,
      source,
      materializationId,
      execution,
      rows: [objectRow("two", 2)],
    })
    await expect(
      storage.markReady({
        projectId,
        source,
        materializationId,
        execution,
        rootCount: 2,
        assertionCount: 2,
        readyAt: "2026-02-01T00:01:00.000Z",
      })
    ).rejects.toThrow("missing 1")

    await storage.stageRows({
      projectId,
      source,
      materializationId,
      execution,
      rows: [objectRow("three", 1)],
    })
    await expect(
      storage.markReady({
        projectId,
        source,
        materializationId,
        execution,
        rootCount: 3,
        assertionCount: 2,
        readyAt: "2026-02-01T00:01:00.000Z",
      })
    ).rejects.toThrow("do not match")
    const ready = await storage.markReady({
      projectId,
      source,
      materializationId,
      execution,
      rootCount: 3,
      assertionCount: 3,
      readyAt: "2026-02-01T00:01:00.000Z",
    })
    expect(ready).toMatchObject({ status: "ready", rootCount: 3, assertionCount: 3 })
  })

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

  test("fences every write and lets only a new token reclaim the prior candidate", async () => {
    const { storage, claim } = fixture()
    const oldExecution = claim("stable-run", "old-token")
    await storage.beginMaterialization(beginInput("old-materialization", oldExecution))

    const newExecution = claim("stable-run", "new-token")
    await expect(
      storage.stageRows({
        projectId,
        source,
        materializationId: "old-materialization",
        execution: oldExecution,
        rows: [],
      })
    ).rejects.toThrow("execution lost")
    await expect(
      storage.beginMaterialization(beginInput("new-materialization", newExecution))
    ).rejects.toThrow("reclaim it before beginning another")

    const reclaimed = await storage.abandon({
      kind: "reclaim",
      projectId,
      source,
      execution: newExecution,
      abandonedAt: "2026-02-01T00:02:00.000Z",
    })
    expect(reclaimed).toMatchObject({
      materializationId: "old-materialization",
      status: "abandoned",
      executionToken: null,
    })
    const current = await storage.beginMaterialization(
      beginInput("new-materialization", newExecution, "2026-02-01T00:03:00.000Z")
    )
    expect(current.executionToken).toBe("new-token")
    await expect(
      storage.abandon({
        kind: "reclaim",
        projectId,
        source,
        execution: newExecution,
        abandonedAt: "2026-02-01T00:04:00.000Z",
      })
    ).rejects.toThrow("current execution")

    const abandoned = await storage.abandon({
      kind: "candidate",
      projectId,
      source,
      materializationId: "new-materialization",
      execution: newExecution,
      abandonedAt: "2026-02-01T00:05:00.000Z",
    })
    expect(abandoned).toMatchObject({ status: "abandoned", executionToken: null })
    expect(
      await storage.abandon({
        kind: "candidate",
        projectId,
        source,
        materializationId: "new-materialization",
        execution: newExecution,
        abandonedAt: "2026-02-01T00:05:00.000Z",
      })
    ).toEqual(abandoned)
  })

  test("cleans only terminal records, deleting bounded rows before their manifest", async () => {
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
    state.sourceMaterializations.set(liveKey, {
      ...readyLive,
      status: "active",
      executionToken: null,
      activatedAt: "2025-01-01T00:02:00.000Z",
      lastCommitId: "cleanup-live-commit",
      updatedAt: "2025-01-01T00:02:00.000Z",
    })

    expect(
      await storage.cleanupTerminal({
        projectId,
        terminalBefore: "2026-02-01T00:00:00.000Z",
        limit: 2,
      })
    ).toEqual({ rowsDeleted: 2, materializationsDeleted: 0 })
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

    expect(
      await storage.cleanupTerminal({
        projectId,
        terminalBefore: "2026-02-01T00:00:00.000Z",
        limit: 1,
      })
    ).toEqual({ rowsDeleted: 0, materializationsDeleted: 1 })
    expect(
      await storage.cleanupTerminal({
        projectId,
        terminalBefore: "2026-01-03T00:00:00.000Z",
        limit: 1,
      })
    ).toEqual({ rowsDeleted: 0, materializationsDeleted: 0 })
    expect(
      await storage.cleanupTerminal({
        projectId,
        terminalBefore: "2026-02-01T00:00:00.000Z",
        limit: 1,
      })
    ).toEqual({ rowsDeleted: 0, materializationsDeleted: 1 })
    expect(state.sourceMaterializations.has(liveKey)).toBe(true)
    expect(await storage.getActive({ projectId, source })).toMatchObject({
      materializationId: "cleanup-live",
      status: "active",
    })
  })
})
