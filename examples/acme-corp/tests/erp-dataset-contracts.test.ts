import { describe, expect, test } from "bun:test"
import { getDatasetRowValidationError } from "@sixb/core"
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
import { createAcmeErpClient } from "../lib/acme-erp"

describe("Acme ERP dataset contracts", () => {
  test("every source row matches its destination dataset", async () => {
    const client = createAcmeErpClient()
    const sources = [
      { dataset: erpDepartmentsDataset, rows: await client.listDepartments() },
      { dataset: erpEmployeesDataset, rows: await client.listEmployees() },
      { dataset: erpCustomersDataset, rows: await client.listCustomers() },
      { dataset: erpProjectsDataset, rows: await client.listProjects() },
      { dataset: erpProjectMembersDataset, rows: await client.listProjectMembers() },
      { dataset: erpDocumentsDataset, rows: await client.listDocuments() },
      { dataset: erpInvoicesDataset, rows: await client.listInvoices() },
      { dataset: erpTasksDataset, rows: await client.listTasks() },
      { dataset: erpProjectProgressDataset, rows: await client.listProjectProgress() },
    ]

    for (const { dataset, rows } of sources) {
      for (const [index, row] of rows.entries()) {
        expect(
          getDatasetRowValidationError(row, dataset),
          `${dataset.id} row ${index + 1}`
        ).toBeNull()
      }
    }
  })
})
