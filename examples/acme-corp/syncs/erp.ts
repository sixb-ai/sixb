import { defineSync, syncFinished } from "@sixb/core"
import { acmeErpConnector } from "../connectors/acme-erp"
import {
  erpCustomersDataset,
  erpDepartmentsDataset,
  erpDocumentsDataset,
  erpEmployeesDataset,
  erpInvoicesDataset,
  erpProjectMembersDataset,
  erpProjectsDataset,
  erpTasksDataset,
} from "../datasets/erp"
import { hourlyErpSync } from "../schedules/erp"

export const syncErpDepartments = defineSync("sync-erp-departments")
  .when(hourlyErpSync)
  .from(acmeErpConnector)
  .read((client) => client.listDepartments())
  .intoDataset(erpDepartmentsDataset)

export const syncErpEmployees = defineSync("sync-erp-employees")
  .when(syncFinished(syncErpDepartments.id))
  .from(acmeErpConnector)
  .read((client) => client.listEmployees())
  .intoDataset(erpEmployeesDataset)

export const syncErpCustomers = defineSync("sync-erp-customers")
  .when(syncFinished(syncErpEmployees.id))
  .from(acmeErpConnector)
  .read((client) => client.listCustomers())
  .intoDataset(erpCustomersDataset)

export const syncErpProjects = defineSync("sync-erp-projects")
  .when(syncFinished(syncErpCustomers.id))
  .from(acmeErpConnector)
  .read((client) => client.listProjects())
  .intoDataset(erpProjectsDataset)

export const syncErpProjectMembers = defineSync("sync-erp-project-members")
  .when(syncFinished(syncErpProjects.id))
  .from(acmeErpConnector)
  .read((client) => client.listProjectMembers())
  .intoDataset(erpProjectMembersDataset)

export const syncErpDocuments = defineSync("sync-erp-documents")
  .when(syncFinished(syncErpProjectMembers.id))
  .from(acmeErpConnector)
  .read((client) => client.listDocuments())
  .intoDataset(erpDocumentsDataset)

export const syncErpInvoices = defineSync("sync-erp-invoices")
  .when(syncFinished(syncErpDocuments.id))
  .from(acmeErpConnector)
  .read((client) => client.listInvoices())
  .intoDataset(erpInvoicesDataset)

export const syncErpTasks = defineSync("sync-erp-tasks")
  .when(syncFinished(syncErpInvoices.id))
  .from(acmeErpConnector)
  .read((client) => client.listTasks())
  .intoDataset(erpTasksDataset)
