import { describe, expect, test } from "bun:test"
import { type RuntimeAccessPlan, snapshotRuntimeAccessPlan } from "../src/authorization/access-plan"
import {
  createDelegatedRuntimeAuthorization,
  getAuthorizationRef,
  resolveRuntimeAuthorization,
} from "../src/execution/authorization"
import { createDelegatedRequestScope } from "../src/execution/scopes"
import type { ObjectReadNode, SelectedObjectReadScope } from "../src/storage"

describe("runtime access plans", () => {
  test("validates, detaches, and freezes delegated authority", () => {
    const propertyIds = ["id", "title"]
    const subjects = [{ objectTypeId: "Proposal", primaryId: "proposal-1" }]
    const input: RuntimeAccessPlan = {
      grants: [
        {
          kind: "object.view",
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
                node: {
                  objects: [{ objectTypeId: "Proposal", propertyIds }],
                  links: [],
                },
              },
            ],
          },
        },
        { kind: "action.apply", actionId: "approve", subjects },
      ],
    }

    const snapshot = snapshotRuntimeAccessPlan(input)
    propertyIds.push("late-secret")
    subjects[0]!.primaryId = "proposal-2"

    expect(snapshot).toEqual({
      grants: [
        {
          kind: "object.view",
          selection: {
            kind: "selected",
            roots: [
              {
                anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
                node: {
                  objects: [{ objectTypeId: "Proposal", propertyIds: ["id", "title"] }],
                  links: [],
                },
              },
            ],
          },
        },
        {
          kind: "action.apply",
          actionId: "approve",
          subjects: [{ objectTypeId: "Proposal", primaryId: "proposal-1" }],
        },
      ],
    })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.grants)).toBe(true)
    expect(Object.isFrozen(snapshot.grants[0])).toBe(true)
    expect(
      Object.isFrozen(
        snapshot.grants[0]?.kind === "object.view"
          ? snapshot.grants[0].selection.roots[0]?.node.objects[0]?.propertyIds
          : undefined
      )
    ).toBe(true)
  })

  test("captures getter-backed plans once and rejects cyclic snapshots with a bounded error", () => {
    const validSelection: SelectedObjectReadScope = {
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
          node: {
            objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
            links: [],
          },
        },
      ],
    }
    const cyclicNode: ObjectReadNode = {
      objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
      links: [],
    }
    ;(cyclicNode.links as ObjectReadNode["links"][number][]).push({
      definitions: [
        {
          sourceObjectTypeId: "Proposal",
          linkId: "items",
          targetObjectTypeIds: ["Proposal"],
          propertyIds: [],
        },
      ],
      target: cyclicNode,
    })
    const cyclicSelection: SelectedObjectReadScope = {
      kind: "selected",
      roots: [
        {
          anchor: { objectTypeId: "Proposal", primaryId: "proposal-1" },
          node: cyclicNode,
        },
      ],
    }

    let grantsReads = 0
    let selectionReads = 0
    const switchingGrant = {
      kind: "object.view" as const,
      get selection() {
        selectionReads += 1
        return selectionReads === 1 ? validSelection : cyclicSelection
      },
    }
    const getterBackedPlan = {
      get grants() {
        grantsReads += 1
        return [switchingGrant]
      },
    }

    expect(snapshotRuntimeAccessPlan(getterBackedPlan)).toEqual({
      grants: [{ kind: "object.view", selection: validSelection }],
    })
    expect(grantsReads).toBe(1)
    expect(selectionReads).toBe(1)
    expect(() =>
      snapshotRuntimeAccessPlan({
        grants: [{ kind: "object.view", selection: cyclicSelection }],
      })
    ).toThrow("cyclic selection node")
  })

  test("rejects malformed plans with actionable errors", () => {
    const malformed: readonly [unknown, string][] = [
      [null, "must contain scoped grants"],
      [{ grants: [null] }, "Scoped grant 0 must be an object"],
      [
        { grants: [{ kind: "action.apply", actionId: "approve", subjects: null }] },
        "action subjects must be an array",
      ],
      [
        { grants: [{ kind: "object.view", selection: { kind: "all" } }] },
        "requires a selected object read scope",
      ],
    ]

    for (const [input, message] of malformed) {
      expect(() => snapshotRuntimeAccessPlan(input as RuntimeAccessPlan)).toThrow(message)
    }
  })

  test("validates provider limits across the merged view authority", () => {
    const oversized: RuntimeAccessPlan = {
      grants: Array.from({ length: 513 }, (_, index) => ({
        kind: "object.view" as const,
        selection: {
          kind: "selected" as const,
          roots: [
            {
              anchor: { objectTypeId: "Proposal", primaryId: `proposal-${index}` },
              node: {
                objects: [{ objectTypeId: "Proposal", propertyIds: ["id"] }],
                links: [],
              },
            },
          ],
        },
      })),
    }

    expect(() => snapshotRuntimeAccessPlan(oversized)).toThrow(
      "scope exceeds the maximum of 512 selection nodes"
    )
  })

  test("bounds action authority independently from view scope size", () => {
    expect(() =>
      snapshotRuntimeAccessPlan({
        grants: Array.from({ length: 1_025 }, (_, index) => ({
          kind: "action.apply" as const,
          actionId: `action-${index}`,
          subjects: [],
        })),
      })
    ).toThrow("maximum of 1024 scoped grants")

    expect(() =>
      snapshotRuntimeAccessPlan({
        grants: [
          {
            kind: "action.apply",
            actionId: "approve",
            subjects: Array.from({ length: 4_097 }, (_, index) => ({
              objectTypeId: "Proposal",
              primaryId: `proposal-${index}`,
            })),
          },
        ],
      })
    ).toThrow("maximum of 4096 scoped action subjects")
  })

  test("makes only shared-session delegation provenance durable", () => {
    const access: RuntimeAccessPlan = { grants: [] }
    const scope = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "request-1",
      correlationId: "correlation-1",
      access,
      delegation: { kind: "share", id: "grant-1", sessionId: "session-1" },
    })

    expect(scope.execution.requestedBy).toBeUndefined()
    expect(resolveRuntimeAuthorization(scope.authorization)).toMatchObject({
      type: "delegated",
      projectId: "project-1",
      ref: {
        type: "delegated",
        kind: "share",
        id: "grant-1",
        sessionId: "session-1",
      },
    })
    expect(getAuthorizationRef(scope.authorization)).toEqual({
      type: "delegated",
      delegation: {
        kind: "share",
        grantId: "grant-1",
        sessionId: "session-1",
      },
    })

    const processLocal = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "request-process-local",
      correlationId: "correlation-process-local",
      access,
      delegation: { kind: "share", id: "grant-1" },
    })
    expect(() => getAuthorizationRef(processLocal.authorization)).toThrow(
      "Only shared-session delegation can cross a durable execution boundary"
    )

    const spoofed = createDelegatedRuntimeAuthorization({
      execution: scope.execution,
      access,
      delegation: {
        kind: "share",
        id: "grant-1",
        type: "principal",
      } as never,
    })
    const resolved = resolveRuntimeAuthorization(spoofed)
    expect(resolved.type).toBe("delegated")
    if (resolved.type === "delegated") expect(resolved.ref.type).toBe("delegated")
  })

  test("validates, snapshots, and defaults execution limits independently from grants", () => {
    const limits = {
      maxTraversalFacts: 7,
      maxMaterializedObjects: 8,
      maxTelemetrySeries: 10,
      maxTelemetryPoints: 11,
      maxVisibleJsonBytes: 9,
    }
    const scope = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "request-limits",
      correlationId: "correlation-limits",
      access: { grants: [] },
      limits,
      delegation: { kind: "share", id: "grant-limits" },
    })
    limits.maxTraversalFacts = 70

    expect(resolveRuntimeAuthorization(scope.authorization)).toMatchObject({
      type: "delegated",
      limits: {
        maxTraversalFacts: 7,
        maxMaterializedObjects: 8,
        maxTelemetrySeries: 10,
        maxTelemetryPoints: 11,
        maxVisibleJsonBytes: 9,
      },
    })

    const defaulted = createDelegatedRequestScope({
      projectId: "project-1",
      requestId: "request-default-limits",
      correlationId: "correlation-default-limits",
      access: { grants: [] },
      delegation: { kind: "share", id: "grant-default-limits" },
    })
    expect(resolveRuntimeAuthorization(defaulted.authorization)).toMatchObject({
      type: "delegated",
      limits: {
        maxTraversalFacts: 10_000,
        maxMaterializedObjects: 10_000,
        maxTelemetrySeries: 100,
        maxTelemetryPoints: 10_000,
        maxVisibleJsonBytes: 8 * 1024 * 1024,
      },
    })

    expect(() =>
      createDelegatedRequestScope({
        projectId: "project-1",
        requestId: "request-invalid-limits",
        correlationId: "correlation-invalid-limits",
        access: { grants: [] },
        limits: {
          maxTraversalFacts: 0,
          maxMaterializedObjects: 1,
          maxTelemetrySeries: 1,
          maxTelemetryPoints: 1,
          maxVisibleJsonBytes: 1,
        },
        delegation: { kind: "share", id: "grant-invalid-limits" },
      })
    ).toThrow("maxTraversalFacts must be a positive safe integer")
  })
})
