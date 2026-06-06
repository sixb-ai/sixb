import type { ObjectProjectionDefinition } from "@sixb/core"
import { defineProjection } from "@sixb/core"
import { erpEmployeesDataset } from "../datasets/erp"
import { Department } from "../ontology/department"
import { Employee } from "../ontology/employee"

export const employeeProjection: ObjectProjectionDefinition = defineProjection(
  "employee-proj",
  Employee
)
  .fromDataset(erpEmployeesDataset)
  .properties({
    id: "emp_id",
    name: "full_name",
    email: "email",
    role: "job_title",
    seniority: "seniority_level",
    hireDate: "hire_date",
  })
  .withLinks({
    department: {
      link: Employee.l.department,
      sourceField: "dept_id",
      target: Department,
    },
  })
