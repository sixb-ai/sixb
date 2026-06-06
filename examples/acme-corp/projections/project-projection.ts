import { defineProjection } from "@sixb/core"
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
  })
  .withLinks({
    customer: {
      link: Project.l.customer,
      sourceField: "customer_id",
      target: Customer,
    },
    lead: {
      link: Project.l.lead,
      sourceField: "lead_emp_id",
      target: Employee,
    },
  })
