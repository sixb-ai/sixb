import { defineTelemetryProjection } from "@sixb/core"
import { erpProjectProgressDataset } from "../datasets/erp"
import { Project } from "../ontology/project"

export const projectProgressProjection = defineTelemetryProjection(
  "project-progress",
  Project.p.progress
)
  .fromDataset(erpProjectProgressDataset)
  .points({
    objectId: "project_id",
    at: "recorded_at",
    value: "progress_pct",
  })
