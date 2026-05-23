import { defineProjection, fromForeignKey } from "@sixb/core"
import { erpProjectsDataset } from "../datasets/erp"
import { Customer } from "../ontology/customer"
import { Employee } from "../ontology/employee"
import { Project } from "../ontology/project"

export const projectProjection = defineProjection("project-proj", Project)
  .fromDataset(erpProjectsDataset)
  .properties({
    id: "project_id",
    name: "project_name",
    description: "description",
    status: "status",
    startDate: "start_date",
    deadline: "deadline",
    budget: "budget_amount",
    customerRef: "customer_id",
    leadRef: "lead_emp_id",
  })
  .withLinks({
    customer: fromForeignKey({
      link: Project.l.customer,
      sourceProperty: Project.p.customerRef,
      target: Customer,
    }),
    lead: fromForeignKey({
      link: Project.l.lead,
      sourceProperty: Project.p.leadRef,
      target: Employee,
    }),
  })
