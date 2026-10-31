import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import type { WorkflowSummary } from "../src/pages/console/ontology/workflows/utils"
import { WorkflowCard } from "../src/pages/console/ontology/workflows/workflow-card"

const workflow = {
  id: "service-response",
  input: { serviceCaseId: "string" },
  triggers: [{ type: "schedule", scheduleId: "hourly" }],
  nodes: [
    { type: "step", id: "one", key: "loadContext", input: {}, output: {} },
    { type: "intervention", id: "two", key: "reviewDispatch", input: {}, response: {} },
    { type: "action", id: "three", key: "dispatchWorkOrder", params: {} },
    { type: "agent", id: "four", key: "summarizeVisit", input: {}, output: {} },
    { type: "step", id: "five", key: "recordOutcome", input: {}, output: {} },
    { type: "step", id: "six", key: "notifyCustomer", input: {}, output: {} },
  ],
  latestRun: null,
} satisfies WorkflowSummary

test("workflow cards keep the catalog summary compact", () => {
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <WorkflowCard workflow={workflow} />
    </MemoryRouter>
  )

  expect(markup).toContain("Service Response")
  expect(markup).toContain('href="/console/workflows/service-response"')
  expect(markup).toContain("6 nodes · 1 trigger · 1 input field")
  expect(markup).toContain("No runs recorded")
  expect(markup).not.toContain("Structure")
  expect(markup).not.toContain("Run workflow")
})
