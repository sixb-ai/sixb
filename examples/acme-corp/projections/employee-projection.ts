import { defineProjection, fromForeignKey } from "@pario/core"
import { erpEmployeesDataset } from "../datasets/erp"
import { Department } from "../ontology/department"
import { Employee } from "../ontology/employee"

export const employeeProjection = defineProjection("employee-proj", Employee)
  .fromDataset(erpEmployeesDataset)
  .properties({
    id: "emp_id",
    name: "full_name",
    email: "email",
    role: "job_title",
    seniority: "seniority_level",
    hireDate: "hire_date",
    departmentRef: "dept_id",
  })
  .withLinks({
    department: fromForeignKey({
      link: Employee.l.department,
      sourceProperty: Employee.p.departmentRef,
      target: Department,
    }),
  })
