import { describe, expect, test } from "bun:test"
import { change, col, defineDataset } from "../src"
import {
  cloneDatasetMergeChange,
  encodeDatasetPrimaryKey,
  getDatasetMergeChangeValidationError,
  getDatasetPrimaryKeyColumns,
} from "../src/lake-storage"

const invoices = defineDataset("contract.merge-validation.invoices", {
  schema: [col("id", "string"), col("status", "string")],
  primaryKey: "id",
})

const lineItems = defineDataset("contract.merge-validation.line-items", {
  schema: [
    col("invoiceId", "string"),
    col("lineItemId", "string"),
    col("description", "string", { nullable: true }),
  ],
  primaryKey: ["invoiceId", "lineItemId"],
})

describe("dataset merge validation", () => {
  test("normalizes single and composite primary keys without delimiter collisions", () => {
    expect(getDatasetPrimaryKeyColumns(invoices)).toEqual(["id"])
    expect(getDatasetPrimaryKeyColumns(lineItems)).toEqual(["invoiceId", "lineItemId"])

    const left = encodeDatasetPrimaryKey(lineItems, {
      invoiceId: "invoice|line",
      lineItemId: "item",
    })
    const right = encodeDatasetPrimaryKey(lineItems, {
      invoiceId: "invoice",
      lineItemId: "line|item",
    })

    expect(left).not.toBe(right)
    expect(left).toBe('["invoice|line","item"]')
  })

  test("validates complete upserts and exact delete keys", () => {
    expect(
      getDatasetMergeChangeValidationError(change.upsert({ id: "inv_1", status: "open" }), invoices)
    ).toBeNull()
    expect(
      getDatasetMergeChangeValidationError(change.delete({ id: "inv_1" }), invoices)
    ).toBeNull()
    expect(
      getDatasetMergeChangeValidationError(
        change.delete({ invoiceId: "inv_1", lineItemId: "line_1" }),
        lineItems
      )
    ).toBeNull()

    expect(
      getDatasetMergeChangeValidationError(change.upsert({ id: "inv_1" }), invoices)
    ).toContain("missing required column 'status'")
    expect(getDatasetMergeChangeValidationError(change.delete({}), invoices)).toContain(
      "missing primary-key column 'id'"
    )
    expect(
      getDatasetMergeChangeValidationError(change.delete({ id: "inv_1", extra: "x" }), invoices)
    ).toContain("unknown column 'extra'")
    expect(getDatasetMergeChangeValidationError(change.delete({ id: 42 }), invoices)).toContain(
      "column 'id' must be a string"
    )
  })

  test("rejects malformed changes and unkeyed datasets", () => {
    const unkeyed = defineDataset("contract.merge-validation.unkeyed", {
      schema: [col("id", "string")],
    })

    expect(getDatasetMergeChangeValidationError(change.delete({ id: "1" }), unkeyed)).toContain(
      "must define a primaryKey"
    )
    expect(getDatasetMergeChangeValidationError(null, invoices)).toContain("plain objects")
    expect(getDatasetMergeChangeValidationError({ kind: "patch", row: {} }, invoices)).toContain(
      "kind must be 'upsert' or 'delete'"
    )
    expect(
      getDatasetMergeChangeValidationError(
        { kind: "upsert", row: { id: "1", status: "open" }, extra: true },
        invoices
      )
    ).toContain("unknown field 'extra'")
    expect(getDatasetMergeChangeValidationError({ kind: "delete" }, invoices)).toContain(
      "missing 'key'"
    )
  })

  test("clones staged changes defensively", () => {
    const row = { id: "inv_1", status: "open" }
    const key = { id: "inv_2" }
    const clonedUpsert = cloneDatasetMergeChange(change.upsert(row))
    const clonedDelete = cloneDatasetMergeChange(change.delete(key))

    row.status = "closed"
    key.id = "inv_3"

    expect(clonedUpsert).toEqual({ kind: "upsert", row: { id: "inv_1", status: "open" } })
    expect(clonedDelete).toEqual({ kind: "delete", key: { id: "inv_2" } })
  })
})
