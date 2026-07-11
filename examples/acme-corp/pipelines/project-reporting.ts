import type { DatasetRow } from "@sixb/core"
import { definePipeline, definePipelineStep, defineSchedule, events } from "@sixb/core"
import {
  erpActiveProjectsDataset,
  erpProjectSummariesDataset,
  erpProjectsDataset,
} from "../datasets/erp"

async function* activeProjects(rows: AsyncIterable<DatasetRow>) {
  for await (const row of rows) {
    if (row.status === "active") {
      yield row
    }
  }
}

async function* projectSummaries(rows: AsyncIterable<DatasetRow>) {
  for await (const row of rows) {
    yield {
      project_id: row.project_id,
      project_name: row.project_name,
      status: row.status,
      budget_amount: row.budget_amount,
      customer_id: row.customer_id,
      lead_emp_id: row.lead_emp_id,
    }
  }
}

export const activeProjectsStep = definePipelineStep("active-projects")
  .inputs({ projects: erpProjectsDataset })
  .output(erpActiveProjectsDataset)
  .run(async ({ inputs, output }) => {
    await output.writeRows(activeProjects(inputs.projects.readRows()))
  })

export const projectSummariesStep = definePipelineStep("project-summaries")
  .inputs({ projects: erpActiveProjectsDataset })
  .output(erpProjectSummariesDataset)
  .run(async ({ inputs, output }) => {
    await output.writeRows(projectSummaries(inputs.projects.readRows()))
  })

export const erpProjectsUpdated = defineSchedule("erp-projects-updated").on(
  events.dataset(erpProjectsDataset).updated()
)

export const projectReportingPipeline = definePipeline("project-reporting")
  .when(erpProjectsUpdated)
  .then(activeProjectsStep)
  .then(projectSummariesStep)
