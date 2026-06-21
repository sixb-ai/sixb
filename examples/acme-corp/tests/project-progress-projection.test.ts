/**
 * Wiring check for the telemetry projection added to the acme-corp example:
 * the runtime discovers `project-progress`, startup validation accepts it, and
 * the definition maps the ERP progress columns onto `Project.progress`.
 */
import { describe, expect, test } from "bun:test"
import {
  InMemoryBlobStorage,
  InMemoryBroker,
  InMemoryLakeStorage,
  InMemoryQueues,
  InMemoryStorage,
  Sixb,
} from "@sixb/core"
import { erpProjectProgressDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Department } from "../ontology/department"
import { Employee } from "../ontology/employee"
import { Project } from "../ontology/project"
import { projectProgressProjection } from "../projections/project-progress-projection"

function createRuntime() {
  return new Sixb({
    id: "acme-project-progress-test",
    ontology: [Project, Customer, Employee, Department],
    broker: new InMemoryBroker(),
    storage: new InMemoryStorage(),
    lakeStorage: new InMemoryLakeStorage(),
    blobStorage: new InMemoryBlobStorage(),
    queues: new InMemoryQueues(),
    datasets: [erpProjectProgressDataset],
    projections: [projectProgressProjection],
  })
}

describe("project-progress telemetry projection", () => {
  test("startup validation accepts the projection and registers it", () => {
    const sixb = createRuntime()

    const telemetryProjections = sixb.getTelemetryProjections()
    expect(telemetryProjections.map((projection) => projection.id)).toContain("project-progress")
    expect(sixb.getProjectionById("project-progress")).not.toBeNull()
  })

  test("maps the ERP progress columns onto Project.progress", () => {
    expect(projectProgressProjection).toMatchObject({
      _tag: "TelemetryProjectionDefinition",
      id: "project-progress",
      objectTypeId: "Project",
      propertyId: "progress",
      datasetId: "erp.project_progress",
      objectIdField: "project_id",
      atField: "recorded_at",
      valueField: "progress_pct",
    })
    // progress is unitless, so the mapping must not carry a unit field.
    expect(projectProgressProjection).not.toHaveProperty("unitField")
  })
})
