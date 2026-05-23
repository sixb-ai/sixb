import type { ObjectProjectionDefinition } from "@sixb/core"
import { defineProjection } from "@sixb/core"
import { erpDepartmentsDataset } from "../datasets/erp"
import { Department } from "../ontology/department"

export const departmentProjection: ObjectProjectionDefinition = defineProjection(
  "dept-proj",
  Department
)
  .fromDataset(erpDepartmentsDataset)
  .properties({
    id: "dept_id",
    name: "dept_name",
    code: "dept_code",
  })
