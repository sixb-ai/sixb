import { describe, expect, test } from "bun:test"
import { parseLoadedCopy } from "../src/branches/runtime"

// A copy recorded before skips had a kind: in a hosted branch's row or a laptop's index, read by
// a newer runtime or Console.
describe("a loaded copy recorded before its report had kinds", () => {
  // Red check: in storage/branches/record.ts, make `skipKind` return "unfit" whenever `kind` is
  // absent: the old unreadable, removed and primary skips all read as unfit.
  test("reads each skip's kind from its reason, and the fields it lacks as empty", () => {
    const copy = parseLoadedCopy({
      takenAt: "2026-11-24T12:00:00.000Z",
      objects: 12,
      skipped: [
        { objectTypeId: "payslip", reason: "the person who took it cannot read this type" },
        { objectTypeId: "invoice", reason: "the branch no longer defines this type" },
        { objectTypeId: "crew", reason: "its primary property changed from 'id' to 'name'" },
        { objectTypeId: "ticket", reason: "property 'status' changed its type or mode" },
      ],
      skippedDatasets: [],
      lakeSliceId: null,
    })

    expect(
      copy?.skipped.map(({ objectTypeId, kind, findings }) => [objectTypeId, kind, findings])
    ).toEqual([
      ["payslip", "unreadable", []],
      ["invoice", "removed", []],
      ["crew", "primary", []],
      ["ticket", "unfit", []],
    ])
    expect(copy).toMatchObject({ partial: [], refusedByDeploy: [], unchecked: [], migrated: [] })
  })
})
