export interface ErpDepartmentRow {
  readonly dept_id: string
  readonly dept_name: string
  readonly dept_code: string
}

export interface ErpEmployeeRow {
  readonly emp_id: string
  readonly full_name: string
  readonly email: string
  readonly job_title: string
  readonly seniority_level: string
  readonly hire_date: string
  readonly dept_id: string
}

export interface ErpCustomerRow {
  readonly customer_id: string
  readonly contact_name: string
  readonly contact_email: string
  readonly company_name: string
  readonly industry_sector: string
  readonly service_tier: string
  readonly account_mgr_id: string
}

export interface ErpProjectRow {
  readonly project_id: string
  readonly project_name: string
  readonly description: string
  readonly status: string
  readonly start_date: string
  readonly deadline: string
  readonly budget_amount: number
  readonly customer_id: string
  readonly lead_emp_id: string
}

export interface ErpProjectMemberRow {
  readonly project_id: string
  readonly employee_id: string
}

export interface ErpDocumentRow {
  readonly id: string
  readonly title: string
  readonly type: string
  readonly version: string
  readonly createdAt: string
  readonly projectRef: string
  readonly authorRef: string
}

export interface ErpInvoiceRow {
  readonly id: string
  readonly number: string
  readonly amount: number
  readonly currency: string
  readonly status: string
  readonly issuedAt: string
  readonly dueDate: string
  readonly customerRef: string
  readonly projectRef: string
}

export interface ErpTaskRow {
  readonly id: string
  readonly title: string
  readonly status: string
  readonly priority: string
  readonly estimate: number
  readonly dueDate: string
  readonly projectRef: string
  readonly assigneeRef: string
}

export interface AcmeErpClient {
  listDepartments(): Promise<readonly ErpDepartmentRow[]>
  listEmployees(): Promise<readonly ErpEmployeeRow[]>
  listCustomers(): Promise<readonly ErpCustomerRow[]>
  listProjects(): Promise<readonly ErpProjectRow[]>
  listProjectMembers(): Promise<readonly ErpProjectMemberRow[]>
  listDocuments(): Promise<readonly ErpDocumentRow[]>
  listInvoices(): Promise<readonly ErpInvoiceRow[]>
  listTasks(): Promise<readonly ErpTaskRow[]>
}

const departments = [
  { dept_id: "dept-eng", dept_name: "Engineering", dept_code: "ENG" },
  { dept_id: "dept-sales", dept_name: "Sales", dept_code: "SALES" },
  { dept_id: "dept-design", dept_name: "Design", dept_code: "DSN" },
  { dept_id: "dept-finance", dept_name: "Finance", dept_code: "FIN" },
] satisfies readonly ErpDepartmentRow[]

const employees = [
  {
    emp_id: "emp-alice",
    full_name: "Alice Martin",
    email: "alice@acme.corp",
    job_title: "Engineering Lead",
    seniority_level: "lead",
    hire_date: "2020-03-15",
    dept_id: "dept-eng",
  },
  {
    emp_id: "emp-bob",
    full_name: "Bob Chen",
    email: "bob@acme.corp",
    job_title: "Senior Engineer",
    seniority_level: "senior",
    hire_date: "2021-06-01",
    dept_id: "dept-eng",
  },
  {
    emp_id: "emp-clara",
    full_name: "Clara Dupont",
    email: "clara@acme.corp",
    job_title: "Sales Director",
    seniority_level: "director",
    hire_date: "2019-01-10",
    dept_id: "dept-sales",
  },
  {
    emp_id: "emp-david",
    full_name: "David Kim",
    email: "david@acme.corp",
    job_title: "Account Manager",
    seniority_level: "mid",
    hire_date: "2022-09-20",
    dept_id: "dept-sales",
  },
  {
    emp_id: "emp-emma",
    full_name: "Emma Fischer",
    email: "emma@acme.corp",
    job_title: "UX Designer",
    seniority_level: "senior",
    hire_date: "2021-11-05",
    dept_id: "dept-design",
  },
  {
    emp_id: "emp-francois",
    full_name: "Francois Leclerc",
    email: "francois@acme.corp",
    job_title: "CFO",
    seniority_level: "director",
    hire_date: "2018-06-01",
    dept_id: "dept-finance",
  },
] satisfies readonly ErpEmployeeRow[]

const customers = [
  {
    customer_id: "cust-techstart",
    contact_name: "Marie Laurent",
    contact_email: "marie@techstart.io",
    company_name: "TechStart SAS",
    industry_sector: "Technology",
    service_tier: "gold",
    account_mgr_id: "emp-david",
  },
  {
    customer_id: "cust-greenenergy",
    contact_name: "Hans Weber",
    contact_email: "hans@greenenergy.de",
    company_name: "GreenEnergy GmbH",
    industry_sector: "Energy",
    service_tier: "platinum",
    account_mgr_id: "emp-clara",
  },
  {
    customer_id: "cust-eduplatform",
    contact_name: "Sarah Johnson",
    contact_email: "sarah@eduplatform.com",
    company_name: "EduPlatform Inc",
    industry_sector: "Education",
    service_tier: "silver",
    account_mgr_id: "emp-david",
  },
  {
    customer_id: "cust-healthfirst",
    contact_name: "Dr. Sophie Muller",
    contact_email: "sophie@healthfirst.co.uk",
    company_name: "HealthFirst Ltd",
    industry_sector: "Healthcare",
    service_tier: "gold",
    account_mgr_id: "emp-clara",
  },
] satisfies readonly ErpCustomerRow[]

const projects = [
  {
    project_id: "proj-techstart-platform",
    project_name: "TechStart Platform",
    description: "Full-stack SaaS platform for TechStart's core product.",
    status: "active",
    start_date: "2024-01-15",
    deadline: "2024-12-31",
    budget_amount: 250000,
    customer_id: "cust-techstart",
    lead_emp_id: "emp-alice",
  },
  {
    project_id: "proj-greenenergy-dashboard",
    project_name: "GreenEnergy Dashboard",
    description: "Real-time energy monitoring dashboard.",
    status: "active",
    start_date: "2024-03-01",
    deadline: "2024-09-30",
    budget_amount: 180000,
    customer_id: "cust-greenenergy",
    lead_emp_id: "emp-bob",
  },
  {
    project_id: "proj-eduplatform-redesign",
    project_name: "EduPlatform Redesign",
    description: "UX overhaul of the learning management system.",
    status: "draft",
    start_date: "2024-06-01",
    deadline: "2025-03-31",
    budget_amount: 120000,
    customer_id: "cust-eduplatform",
    lead_emp_id: "emp-emma",
  },
  {
    project_id: "proj-healthfirst-portal",
    project_name: "HealthFirst Portal",
    description: "Patient portal with appointment scheduling.",
    status: "completed",
    start_date: "2023-06-01",
    deadline: "2024-01-31",
    budget_amount: 320000,
    customer_id: "cust-healthfirst",
    lead_emp_id: "emp-alice",
  },
] satisfies readonly ErpProjectRow[]

const projectMembers = [
  { project_id: "proj-techstart-platform", employee_id: "emp-alice" },
  { project_id: "proj-techstart-platform", employee_id: "emp-bob" },
  { project_id: "proj-techstart-platform", employee_id: "emp-emma" },
  { project_id: "proj-greenenergy-dashboard", employee_id: "emp-bob" },
  { project_id: "proj-greenenergy-dashboard", employee_id: "emp-emma" },
  { project_id: "proj-eduplatform-redesign", employee_id: "emp-emma" },
  { project_id: "proj-eduplatform-redesign", employee_id: "emp-david" },
  { project_id: "proj-healthfirst-portal", employee_id: "emp-alice" },
  { project_id: "proj-healthfirst-portal", employee_id: "emp-bob" },
  { project_id: "proj-healthfirst-portal", employee_id: "emp-francois" },
] satisfies readonly ErpProjectMemberRow[]

const documents = [
  {
    id: "doc-techstart-proposal",
    title: "TechStart Platform - Technical Proposal",
    type: "proposal",
    version: "2.1",
    createdAt: "2024-01-05T10:00:00Z",
    projectRef: "proj-techstart-platform",
    authorRef: "emp-alice",
  },
  {
    id: "doc-techstart-contract",
    title: "TechStart Platform - Service Agreement",
    type: "contract",
    version: "1.0",
    createdAt: "2024-01-12T14:30:00Z",
    projectRef: "proj-techstart-platform",
    authorRef: "emp-clara",
  },
  {
    id: "doc-greenenergy-spec",
    title: "GreenEnergy Dashboard - Functional Specification",
    type: "specification",
    version: "1.3",
    createdAt: "2024-02-20T09:00:00Z",
    projectRef: "proj-greenenergy-dashboard",
    authorRef: "emp-bob",
  },
  {
    id: "doc-healthfirst-report",
    title: "HealthFirst Portal - Final Delivery Report",
    type: "report",
    version: "1.0",
    createdAt: "2024-01-28T16:00:00Z",
    projectRef: "proj-healthfirst-portal",
    authorRef: "emp-alice",
  },
] satisfies readonly ErpDocumentRow[]

const invoices = [
  {
    id: "inv-001",
    number: "INV-2024-001",
    amount: 62500,
    currency: "EUR",
    status: "paid",
    issuedAt: "2024-04-01T00:00:00Z",
    dueDate: "2024-04-30",
    customerRef: "cust-techstart",
    projectRef: "proj-techstart-platform",
  },
  {
    id: "inv-002",
    number: "INV-2024-002",
    amount: 45000,
    currency: "EUR",
    status: "sent",
    issuedAt: "2024-07-01T00:00:00Z",
    dueDate: "2024-07-31",
    customerRef: "cust-greenenergy",
    projectRef: "proj-greenenergy-dashboard",
  },
  {
    id: "inv-003",
    number: "INV-2024-003",
    amount: 62500,
    currency: "EUR",
    status: "paid",
    issuedAt: "2024-07-01T00:00:00Z",
    dueDate: "2024-07-31",
    customerRef: "cust-techstart",
    projectRef: "proj-techstart-platform",
  },
  {
    id: "inv-004",
    number: "INV-2024-004",
    amount: 30000,
    currency: "GBP",
    status: "overdue",
    issuedAt: "2024-05-01T00:00:00Z",
    dueDate: "2024-05-31",
    customerRef: "cust-healthfirst",
    projectRef: "proj-healthfirst-portal",
  },
  {
    id: "inv-005",
    number: "INV-2024-005",
    amount: 40000,
    currency: "USD",
    status: "draft",
    issuedAt: "2024-08-01T00:00:00Z",
    dueDate: "2024-08-31",
    customerRef: "cust-eduplatform",
    projectRef: "proj-eduplatform-redesign",
  },
] satisfies readonly ErpInvoiceRow[]

const tasks = [
  {
    id: "task-001",
    title: "Set up CI/CD pipeline",
    status: "done",
    priority: "high",
    estimate: 8,
    dueDate: "2024-02-01",
    projectRef: "proj-techstart-platform",
    assigneeRef: "emp-bob",
  },
  {
    id: "task-002",
    title: "Design landing page wireframes",
    status: "done",
    priority: "high",
    estimate: 5,
    dueDate: "2024-02-15",
    projectRef: "proj-techstart-platform",
    assigneeRef: "emp-emma",
  },
  {
    id: "task-003",
    title: "Implement user authentication",
    status: "in_progress",
    priority: "critical",
    estimate: 13,
    dueDate: "2024-04-15",
    projectRef: "proj-techstart-platform",
    assigneeRef: "emp-alice",
  },
  {
    id: "task-004",
    title: "Build real-time data ingestion",
    status: "in_progress",
    priority: "high",
    estimate: 21,
    dueDate: "2024-06-30",
    projectRef: "proj-greenenergy-dashboard",
    assigneeRef: "emp-bob",
  },
  {
    id: "task-005",
    title: "Design dashboard UI components",
    status: "todo",
    priority: "medium",
    estimate: 8,
    dueDate: "2024-07-15",
    projectRef: "proj-greenenergy-dashboard",
    assigneeRef: "emp-emma",
  },
  {
    id: "task-006",
    title: "User research interviews",
    status: "backlog",
    priority: "medium",
    estimate: 5,
    dueDate: "2024-07-01",
    projectRef: "proj-eduplatform-redesign",
    assigneeRef: "emp-emma",
  },
  {
    id: "task-007",
    title: "Write final delivery report",
    status: "done",
    priority: "low",
    estimate: 3,
    dueDate: "2024-01-25",
    projectRef: "proj-healthfirst-portal",
    assigneeRef: "emp-alice",
  },
] satisfies readonly ErpTaskRow[]

function cloneRows<T extends Record<string, unknown>>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }))
}

export function createAcmeErpClient(): AcmeErpClient {
  return {
    async listDepartments() {
      return cloneRows(departments)
    },
    async listEmployees() {
      return cloneRows(employees)
    },
    async listCustomers() {
      return cloneRows(customers)
    },
    async listProjects() {
      return cloneRows(projects)
    },
    async listProjectMembers() {
      return cloneRows(projectMembers)
    },
    async listDocuments() {
      return cloneRows(documents)
    },
    async listInvoices() {
      return cloneRows(invoices)
    },
    async listTasks() {
      return cloneRows(tasks)
    },
  }
}
