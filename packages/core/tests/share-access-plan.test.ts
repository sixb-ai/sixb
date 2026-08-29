import { describe, expect, test } from "bun:test"
import { type ShareAccessPlan, snapshotShareAccessPlan } from "../src/shares/access-plan"
import type { ObjectReadNode, SelectedObjectReadScope } from "../src/storage"

describe("Share access plans", () => {
  test("validates, detaches, and freezes delegated authority", () => {
    const propertyIds = ["id", "title"]
    const subjects = [{ objectTypeId: "Proposal", primaryId: "proposal-1" }]
    const input: ShareAccessPlan = {
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

    const snapshot = snapshotShareAccessPlan(input)
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

    expect(snapshotShareAccessPlan(getterBackedPlan)).toEqual({
      grants: [{ kind: "object.view", selection: validSelection }],
    })
    expect(grantsReads).toBe(1)
    expect(selectionReads).toBe(1)
    expect(() =>
      snapshotShareAccessPlan({
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
      expect(() => snapshotShareAccessPlan(input as ShareAccessPlan)).toThrow(message)
    }
  })

  test("validates provider limits across the merged view authority", () => {
    const oversized: ShareAccessPlan = {
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

    expect(() => snapshotShareAccessPlan(oversized)).toThrow(
      "scope exceeds the maximum of 512 selection nodes"
    )
  })

  test("bounds action authority independently from view scope size", () => {
    expect(() =>
      snapshotShareAccessPlan({
        grants: Array.from({ length: 1_025 }, (_, index) => ({
          kind: "action.apply" as const,
          actionId: `action-${index}`,
          subjects: [],
        })),
      })
    ).toThrow("maximum of 1024 scoped grants")

    expect(() =>
      snapshotShareAccessPlan({
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
})
