import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { coerceBashOutput } from "../src/bash/interpret"
import { ActionRunView } from "../src/bash/renderers"

function render(stdout: unknown): string {
  const parsed = coerceBashOutput({ stdout: JSON.stringify(stdout), exitCode: 0 })
  if (!parsed) throw new Error("Bash output did not parse.")
  return renderToStaticMarkup(<ActionRunView parsed={parsed} />)
}

describe("ActionRunView", () => {
  // Threads stored before `sixb actions request` returned the finished run hold the receipt of a
  // request. Guard proof: default a missing status to "queued" in `ActionRunView`
  // (`src/bash/renderers.tsx`), and that receipt reads as a run that is queued, which no run is.
  test("shows a request receipt as data, not as a queued run", () => {
    const receipt = render({ runId: "act_1", queuedAt: "2026-01-01T00:00:00.000Z", created: true })

    expect(receipt).toContain("act_1")
    expect(receipt).not.toContain("Queued")
  })

  test("shows a run by its status", () => {
    const run = render({
      id: "act_1",
      status: "succeeded",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    })

    expect(run).toContain("Succeeded")
  })
})
