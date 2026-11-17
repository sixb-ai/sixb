import { expect, test } from "bun:test"
import type { ManifestDiff } from "@sixb/core/internal/manifest"
import { diffView } from "../src/ui"

const lines = (view: string) =>
  Bun.stripANSI(view)
    .split("\n")
    .map((line) => line.trim())

test("a diff lists each change and what shipping it does to stored data", () => {
  const diff: ManifestDiff = {
    changes: [
      { kind: "action", id: "approveInvoice", change: "changed", file: "actions/approve.ts" },
      { kind: "objectType", id: "Legacy", change: "removed", file: "ontology/legacy.ts" },
      { kind: "objectType", id: "Vendor", change: "added", file: "ontology/vendor.ts" },
    ],
    plan: {
      projections: [{ id: "invoices", change: "rebuild" }],
      datasets: [{ id: "bills", change: "addColumns", columns: ["vendor_tax_id"] }],
    },
  }

  const view = lines(diffView({ apiUrl: "https://api.example.com", commit: "a41f9c2d", diff }))
  expect(view).toContain("▰ sixb diff  against api.example.com · a41f9c2")
  expect(view).toContain("~ approveInvoice  action       actions/approve.ts")
  expect(view).toContain("− Legacy          object type  ontology/legacy.ts")
  expect(view).toContain("· invoices projection rebuilds")
  expect(view).toContain("· bills dataset gains vendor_tax_id")
  expect(view).toContain("✓ 3 changes · 1 projection to build")
})

test("a dataset change storage refuses is the failure", () => {
  const diff: ManifestDiff = {
    changes: [{ kind: "dataset", id: "bills", change: "changed", file: "datasets/bills.ts" }],
    plan: {
      projections: [],
      datasets: [{ id: "bills", change: "refused", reason: "Primary key is immutable." }],
    },
  }

  const view = lines(diffView({ apiUrl: "https://api.example.com", commit: null, diff }))
  expect(view).toContain("✕ Primary key is immutable.")
  expect(view).toContain("✕ Storage would refuse this deploy · 1 dataset")
})

test("nothing to ship says so", () => {
  const empty: ManifestDiff = { changes: [], plan: { projections: [], datasets: [] } }
  expect(
    lines(diffView({ apiUrl: "https://api.example.com", commit: null, diff: empty }))
  ).toContain("✓ No changes · api.example.com")
})
