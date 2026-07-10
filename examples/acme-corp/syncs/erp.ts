import { defineSchedule, defineSync, events } from "@sixb/core"
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
import { createSampleAttachmentForDocument } from "../lib/sample-files"
import { hourlyErpSync } from "../schedules/hourly-erp"

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
  .read((client, ctx) => {

    const logger = ctx.logger

    logger.info(`[AcmeCorp] Starting sync of ERP departments`)
    logger.debug(`[AcmeCorp] Using demo sync delay of ${demoSyncDelayMs}ms`)
    logger.warn(`[AcmeCorp] This is a demo sync. In production, you would remove the demo delay.`)
    logger.error(`[AcmeCorp] This is a demo sync. In production, you would remove the demo delay.`)
    logger.child({ sync: "erp-departments" }).info(`[AcmeCorp] Starting sync of ERP departments`)

    return readWithDemoDelay("departments", () => client.listDepartments())
  })
  .intoDataset(erpDepartmentsDataset)

export const afterDepartmentsSync = defineSchedule("after-erp-departments").on(
  events.sync(syncErpDepartments).succeeded()
)

export const syncErpEmployees = defineSync("sync-erp-employees")
  .when(afterDepartmentsSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("employees", () => client.listEmployees()))
  .intoDataset(erpEmployeesDataset)

export const afterEmployeesSync = defineSchedule("after-erp-employees").on(
  events.sync(syncErpEmployees).succeeded()
)

export const syncErpCustomers = defineSync("sync-erp-customers")
  .when(afterEmployeesSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("customers", () => client.listCustomers()))
  .intoDataset(erpCustomersDataset)

export const afterCustomersSync = defineSchedule("after-erp-customers").on(
  events.sync(syncErpCustomers).succeeded()
)

export const syncErpProjects = defineSync("sync-erp-projects")
  .when(afterCustomersSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("projects", () => client.listProjects()))
  .intoDataset(erpProjectsDataset)

export const afterProjectsSync = defineSchedule("after-erp-projects").on(
  events.sync(syncErpProjects).succeeded()
)

export const syncErpProjectMembers = defineSync("sync-erp-project-members")
  .when(afterProjectsSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("project members", () => client.listProjectMembers()))
  .intoDataset(erpProjectMembersDataset)

export const afterProjectMembersSync = defineSchedule("after-erp-project-members").on(
  events.sync(syncErpProjectMembers).succeeded()
)

export const syncErpDocuments = defineSync("sync-erp-documents")
  .when(afterProjectMembersSync)
  .from(acmeErpConnector)
  .read(async (client, context) => {
    const rows = await readWithDemoDelay("documents", () => client.listDocuments())
    return Promise.all(
      rows.map(async (row) => {
        const attachment = await createSampleAttachmentForDocument(context.blobs, row.id)
        return attachment ? { ...row, attachment } : row
      })
    )
  })
  .intoDataset(erpDocumentsDataset)

export const afterDocumentsSync = defineSchedule("after-erp-documents").on(
  events.sync(syncErpDocuments).succeeded()
)

export const syncErpInvoices = defineSync("sync-erp-invoices")
  .when(afterDocumentsSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("invoices", () => client.listInvoices()))
  .intoDataset(erpInvoicesDataset)

export const afterInvoicesSync = defineSchedule("after-erp-invoices").on(
  events.sync(syncErpInvoices).succeeded()
)

export const syncErpTasks = defineSync("sync-erp-tasks")
  .when(afterInvoicesSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("tasks", () => client.listTasks()))
  .intoDataset(erpTasksDataset)

export const afterTasksSync = defineSchedule("after-erp-tasks").on(
  events.sync(syncErpTasks).succeeded()
)

export const syncErpProjectProgress = defineSync("sync-erp-project-progress")
  .when(afterTasksSync)
  .from(acmeErpConnector)
  .read((client) => readWithDemoDelay("project progress", () => client.listProjectProgress()))
  .intoDataset(erpProjectProgressDataset)
