import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { WorkflowCard } from "../src/features/workflows/components/workflows/WorkflowCard"
import type { WorkflowSummary } from "../src/features/workflows/utils/workflows"
import { getObjectViewStyle } from "../src/lib/userPreferences"

const workflow = {
  id: "service-response",
  input: { serviceCaseId: "string" },
  triggers: [{ type: "schedule", scheduleId: "hourly" }],
  nodes: [
    { type: "step", id: "one", key: "loadContext", input: {}, output: {} },
    { type: "intervention", id: "two", key: "reviewDispatch", input: {}, response: {} },
    { type: "action", id: "three", key: "dispatchWorkOrder", params: {} },
    { type: "agent", id: "four", key: "summarizeVisit", agentId: "ops", input: {}, output: {} },
    { type: "step", id: "five", key: "recordOutcome", input: {}, output: {} },
    { type: "step", id: "six", key: "notifyCustomer", input: {}, output: {} },
  ],
  latestRun: null,
} satisfies WorkflowSummary

test("object collections default to the table workbench", () => {
  expect(getObjectViewStyle()).toBe("table")
})

test("workflow cards keep the catalog summary compact", () => {
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <WorkflowCard workflow={workflow} />
    </MemoryRouter>
  )

  expect(markup).toContain("Service Response")
  expect(markup).toContain('href="/workflows/service-response"')
  expect(markup).toContain("6 nodes · 1 trigger · 1 input field")
  expect(markup).toContain("No runs recorded")
  expect(markup).not.toContain("Structure")
  expect(markup).not.toContain("Run workflow")
})
