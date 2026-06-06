import { col, defineDataset } from "@sixb/core"

export const erpDepartmentsDataset = defineDataset("erp.departments", {
  schema: [col("dept_id", "string"), col("dept_name", "string"), col("dept_code", "string")],
})

export const erpEmployeesDataset = defineDataset("erp.employees", {
  schema: [
    col("emp_id", "string"),
    col("full_name", "string"),
    col("email", "string"),
    col("job_title", "string"),
    col("seniority_level", "string"),
    col("hire_date", "date"),
    col("dept_id", "string"),
  ],
})

export const erpCustomersDataset = defineDataset("erp.customers", {
  schema: [
    col("customer_id", "string"),
    col("contact_name", "string"),
    col("contact_email", "string"),
    col("company_name", "string"),
    col("industry_sector", "string"),
    col("service_tier", "string"),
    col("account_mgr_id", "string"),
  ],
})

export const erpProjectsDataset = defineDataset("erp.projects", {
  schema: [
    col("project_id", "string"),
    col("project_name", "string"),
    col("description", "string"),
    col("status", "string"),
    col("start_date", "date"),
    col("deadline", "date"),
    col("budget_amount", "decimal"),
    col("customer_id", "string"),
    col("lead_emp_id", "string"),
  ],
})

export const erpActiveProjectsDataset =
  defineDataset("erp.active_projects").derive(erpProjectsDataset)

export const erpProjectSummariesDataset = defineDataset("erp.project_summaries").derive(
  erpProjectsDataset,
  {
    pick: ["project_id", "project_name", "status", "budget_amount", "customer_id", "lead_emp_id"],
  }
)

export const erpProjectMembersDataset = defineDataset("erp.project_members", {
  schema: [col("project_id", "string"), col("employee_id", "string")],
})

export const erpDocumentsDataset = defineDataset("erp.documents", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("type", "string"),
    col("version", "string"),
    col("createdAt", "timestamp"),
    col("project_id", "string"),
    col("author_id", "string"),
  ],
})

export const erpInvoicesDataset = defineDataset("erp.invoices", {
  schema: [
    col("id", "string"),
    col("number", "string"),
    col("amount", "decimal"),
    col("currency", "string"),
    col("status", "string"),
    col("issuedAt", "timestamp"),
    col("dueDate", "date"),
    col("customer_id", "string"),
    col("project_id", "string"),
  ],
})

export const erpTasksDataset = defineDataset("erp.tasks", {
  schema: [
    col("id", "string"),
    col("title", "string"),
    col("status", "string"),
    col("priority", "string"),
    col("estimate", "int64"),
    col("dueDate", "date"),
    col("project_id", "string"),
    col("assignee_id", "string"),
  ],
})
