import { defineRule } from "@pario/core"
import { Customer } from "../ontology/customer"
import { Invoice } from "../ontology/invoice"
import { Project } from "../ontology/project"
import { Task } from "../ontology/task"

export const invoiceCollectionRisk = defineRule("invoice.collection-risk")
  .on(Invoice)
  .where((invoice) =>
    invoice.any(
      invoice.p.status.eq("overdue"),
      invoice.all(invoice.p.status.eq("sent"), invoice.p.amount.gte(40000))
    )
  )

export const projectLargeActiveEngagement = defineRule("project.large-active-engagement")
  .on(Project)
  .where((project) =>
    project.all(
      project.p.status.eq("active"),
      project.p.budget.gte(150000),
      project.l.customer.exists(),
      project.l.lead.exists()
    )
  )

export const taskCriticalInFlight = defineRule("task.critical-in-flight")
  .on(Task)
  .where((task) =>
    task.all(
      task.p.priority.eq("critical"),
      task.not(task.p.status.eq("done")),
      task.l.project.exists(),
      task.l.assignee.exists()
    )
  )

export const customerStrategicAccount = defineRule("customer.strategic-account")
  .on(Customer)
  .where((customer) =>
    customer.all(
      customer.any(customer.p.tier.eq("gold"), customer.p.tier.eq("platinum")),
      customer.l.accountManager.exists()
    )
  )
