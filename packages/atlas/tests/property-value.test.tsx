import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { renderToStaticMarkup } from "react-dom/server"
import { PropertyValue } from "../src/components/objects/PropertyValue"
import { valueSchema } from "../src/lib/valueSchema"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
}
const fileContext = { objectTypeId: "Report", primaryId: "r-1", pathSegments: ["scan"] }
const attachmentMarker = "View download.jpeg"

function render(value: unknown, schema: unknown, valueTypes?: ReadonlyMap<string, unknown>) {
  return renderToStaticMarkup(
    <PropertyValue
      value={value}
      schema={valueSchema(schema, valueTypes)}
      fileContext={fileContext}
    />
  )
}

describe("object detail property values", () => {
  test("renders a string that looks like a date as the string it was declared", () => {
    const value = "2024-03-05T10:00:00.000Z"
    const markup = render(value, "string")
    expect(markup).toContain(`>${value}<`)
    expect(markup).not.toContain("title=")
  })

  test("formats declared timestamps and dates, keeping the raw value as a title", () => {
    const timestamp = "2024-03-05T10:00:00.000Z"
    const timestampMarkup = render(timestamp, "timestamp")
    expect(timestampMarkup).toContain(`title="${timestamp}"`)
    expect(timestampMarkup).not.toContain(`>${timestamp}<`)

    // A date is a calendar day: it must not drift a day in the viewer's zone.
    const expectedDay = new Date(Date.UTC(2024, 2, 5)).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    expect(render("2024-03-05", "date")).toContain(`>${expectedDay}<`)
  })

  test("renders declared files as attachments, singly or as a list", () => {
    expect(render(fileRef, "fileRef")).toContain(attachmentMarker)
    const list = render([fileRef, fileRef], { type: "array", items: "fileRef" })
    expect(list.split(attachmentMarker)).toHaveLength(3)
    expect(
      render(fileRef, { type: "valueTypeRef", valueTypeId: "Scan", _resolved: "fileRef" })
    ).toContain(attachmentMarker)
  })

  test("renders a FileRef-shaped record declared as a record as text", () => {
    const record = {
      type: "object",
      properties: Object.fromEntries(
        Object.keys(fileRef).map((key) => [key, { schema: "string" }])
      ),
    }
    const markup = render(fileRef, record)
    expect(markup).not.toContain(attachmentMarker)
    expect(markup).toContain("download.jpeg")
  })

  test("renders declared users as user chips, singly or as a list", () => {
    const user = { type: "user", id: "usr_1" }
    const userMarker = "text-sky-600"
    const single = render(user, "userRef")
    expect(single).toContain(userMarker)
    expect(single).toContain(">usr_1<")
    const list = render([user, { type: "user", id: "usr_2" }], { type: "array", items: "userRef" })
    expect(list.split(userMarker)).toHaveLength(3)
    expect(list).toContain(">usr_2<")

    // A record shaped like a user, or a value that does not match, stays text.
    const record = {
      type: "object",
      properties: { type: { schema: "string" }, id: { schema: "string" } },
    }
    expect(render(user, record)).not.toContain(userMarker)
    expect(render("usr_1", "userRef")).not.toContain(userMarker)
    expect(render([user, "usr_2"], { type: "array", items: "userRef" })).not.toContain(userMarker)
  })

  test("renders values whose schema Atlas cannot read generically", () => {
    const unresolved = { type: "valueTypeRef", valueTypeId: "Scan" }
    expect(render(fileRef, unresolved)).not.toContain(attachmentMarker)
    expect(render(fileRef, unresolved, new Map([["Scan", "fileRef"]]))).toContain(attachmentMarker)
    expect(render("2024-03-05T10:00:00.000Z", undefined)).toContain(">2024-03-05T10:00:00.000Z<")
  })
})
