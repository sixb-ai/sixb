import { describe, expect, test } from "bun:test"
import { copyNotice } from "../src/commands/dev-runner"

describe("what sixb dev says of a branch's copy", () => {
  // Red check: in dev-runner.ts, append "Migrations ran on what you read." to every "Copied in
  // part" line: the crew, which no migration touched, says one ran on it.
  test("says the migrations ran on what you read only of a type they ran on", () => {
    const lines = copyNotice({
      skipped: [],
      refusedByDeploy: [],
      unchecked: [],
      partial: [
        { objectTypeId: "job", hiddenPropertyIds: ["note"], throughCondition: false },
        { objectTypeId: "crew", hiddenPropertyIds: [], throughCondition: true },
      ],
      migrated: [{ objectTypeId: "job", migrationIds: ["job-gate-code"] }],
    })

    expect(lines).toEqual([
      "Copied in part: job, 'note' hidden from you. Migrations ran on what you read.",
      "Copied in part: crew, some objects hidden from you.",
      "Migrated on the copy: job, by 'job-gate-code'.",
    ])
  })
})
