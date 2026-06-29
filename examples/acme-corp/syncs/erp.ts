import { defineSync, syncFinished } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import {
  erpCustomersDataset,
  erpDepartmentsDataset,
  erpDocumentsDataset,
  erpEmployeesDataset,
  erpInvoicesDataset,
  erpProjectMembersDataset,
  erpProjectProgressDataset,
  erpProjectsDataset,
  erpTasksDataset,
} from "../datasets/erp"
import { hourlyErpSync } from "../schedules/erp"

const demoSyncDelayMs = parseDemoSyncDelayMs(process.env.ACME_SYNC_DELAY_MS)

async function readWithDemoDelay<T>(label: string, read: () => Promise<T>): Promise<T> {
  if (demoSyncDelayMs > 0) {
    console.log(`[AcmeCorp] Delaying ${label} sync read by ${demoSyncDelayMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, demoSyncDelayMs))
  }

  return read()
}

function parseDemoSyncDelayMs(value: string | undefined): number {
  if (!value) return 0

  const delayMs = Number.parseInt(value, 10)
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  return Math.min(delayMs, 30_000)
}

export const syncErpDepartments = defineSync("sync-erp-departments")
  .when(hourlyErpSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("departments", () => client.listDepartments()))
  .intoDataset(erpDepartmentsDataset)

export const syncErpEmployees = defineSync("sync-erp-employees")
  .when(syncFinished(syncErpDepartments.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("employees", () => client.listEmployees()))
  .intoDataset(erpEmployeesDataset)

export const syncErpCustomers = defineSync("sync-erp-customers")
  .when(syncFinished(syncErpEmployees.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("customers", () => client.listCustomers()))
  .intoDataset(erpCustomersDataset)

export const syncErpProjects = defineSync("sync-erp-projects")
  .when(syncFinished(syncErpCustomers.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("projects", () => client.listProjects()))
  .intoDataset(erpProjectsDataset)

export const syncErpProjectMembers = defineSync("sync-erp-project-members")
  .when(syncFinished(syncErpProjects.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("project members", () => client.listProjectMembers()))
  .intoDataset(erpProjectMembersDataset)

export const syncErpDocuments = defineSync("sync-erp-documents")
  .when(syncFinished(syncErpProjectMembers.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("documents", () => client.listDocuments()))
  .intoDataset(erpDocumentsDataset)

export const syncErpInvoices = defineSync("sync-erp-invoices")
  .when(syncFinished(syncErpDocuments.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("invoices", () => client.listInvoices()))
  .intoDataset(erpInvoicesDataset)

export const syncErpTasks = defineSync("sync-erp-tasks")
  .when(syncFinished(syncErpInvoices.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("tasks", () => client.listTasks()))
  .intoDataset(erpTasksDataset)

export const syncErpProjectProgress = defineSync("sync-erp-project-progress")
  .when(syncFinished(syncErpTasks.id))
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("project progress", () => client.listProjectProgress()))
  .intoDataset(erpProjectProgressDataset)
