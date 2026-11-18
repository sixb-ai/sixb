import { expect, test } from "bun:test"
import { arrangeByFolder } from "../src/pages/folders"

const items = [
  { id: "customers" },
  { id: "orders", folder: "raw/erp" },
  { id: "invoices", folder: "raw/erp" },
  { id: "deals", folder: "raw/hubspot" },
  { id: "revenue", folder: "curated" },
  { id: "events", folder: "raw" },
]

const ids = (list: readonly { readonly id: string }[]) => list.map((item) => item.id)

test("the top shows its own items and each folder with everything inside it", () => {
  const top = arrangeByFolder(items, undefined, false)

  expect(top.folder).toBeUndefined()
  expect(ids(top.items)).toEqual(["customers"])
  expect(top.folders).toEqual([
    { name: "curated", path: "curated", count: 1 },
    { name: "raw", path: "raw", count: 4 },
  ])
})

test("a folder shows its own items and its subfolders, not its siblings", () => {
  const raw = arrangeByFolder(items, "raw", false)

  expect(raw.folder).toBe("raw")
  expect(raw.total).toBe(4)
  expect(ids(raw.items)).toEqual(["events"])
  expect(raw.folders).toEqual([
    { name: "erp", path: "raw/erp", count: 2 },
    { name: "hubspot", path: "raw/hubspot", count: 1 },
  ])

  const erp = arrangeByFolder(items, "raw/erp", false)
  expect(ids(erp.items)).toEqual(["orders", "invoices"])
  expect(erp.folders).toEqual([])
})

test("a folder is matched by whole names, so one name starting another stays apart", () => {
  const withPrefix = [...items, { id: "archive", folder: "rawest" }]

  expect(arrangeByFolder(withPrefix, "raw", false).total).toBe(4)
  expect(arrangeByFolder(withPrefix, undefined, false).folders.map((tile) => tile.name)).toEqual([
    "curated",
    "raw",
    "rawest",
  ])
})

test("a folder nothing is in any more opens the top", () => {
  const gone = arrangeByFolder(items, "staging", false)

  expect(gone.folder).toBeUndefined()
  expect(ids(gone.items)).toEqual(["customers"])
})

test("a narrowed list groups every match by folder, the top first", () => {
  const matches = items.filter((item) => item.id.includes("e"))
  const narrowed = arrangeByFolder(matches, "raw", true)

  expect(narrowed.folder).toBeUndefined()
  expect(narrowed.folders).toEqual([])
  expect(narrowed.groups?.map((group) => [group.folder, ids(group.items)])).toEqual([
    [undefined, ["customers"]],
    ["curated", ["revenue"]],
    ["raw", ["events"]],
    ["raw/erp", ["orders", "invoices"]],
    ["raw/hubspot", ["deals"]],
  ])
})

test("a list without folders is a plain list", () => {
  const plain: { id: string; folder?: string }[] = [{ id: "a" }, { id: "b" }]
  const flat = arrangeByFolder(plain, undefined, false)

  expect(flat.active).toBe(false)
  expect(flat.folders).toEqual([])
  expect(ids(flat.items)).toEqual(["a", "b"])
})
