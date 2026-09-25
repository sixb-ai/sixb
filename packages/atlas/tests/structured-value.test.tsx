import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { renderToStaticMarkup } from "react-dom/server"
import { StructuredValue } from "../src/components/StructuredValue"
import { fieldRecordSchema, valueSchema } from "../src/lib/valueSchema"

describe("StructuredValue debug presentation", () => {
  test("keeps short strings and object identifiers readable instead of truncating them", () => {
    const title = "AHU-3 outside-air damper failed to track commanded position"
    const primaryId = "equipment=broad-ahu-3/with/a/long/debug-identifier"
    const markup = renderToStaticMarkup(
      <StructuredValue
        variant="debug"
        value={{
          equipment: { objectTypeId: "Equipment", primaryId },
          title,
        }}
      />
    )

    expect(markup).toContain(title)
    expect(markup).toContain(primaryId)
    expect(markup).toContain("break-all")
    expect(markup).not.toContain("truncate")
    expect(markup).not.toContain("bg-muted/60")
  })

  test("preserves the compact chip presentation outside debugging surfaces", () => {
    const markup = renderToStaticMarkup(<StructuredValue value={{ title: "A compact value" }} />)

    expect(markup).toContain("truncate")
    expect(markup).toContain("bg-muted/60")
  })
})

describe("StructuredValue with a declared schema", () => {
  const fileRef: FileRef = {
    blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sizeBytes: 7789,
    fileName: "download.jpeg",
    mediaType: "image/jpeg",
  }
  const refShaped = { objectTypeId: "Room", primaryId: "room-1" }
  // Only the object-ref chip and its debug form draw the emerald object icon.
  const objectRefMarker = "text-emerald-600"
  const fileMarker = "JPEG image"

  const render = (value: unknown, schema?: unknown, valueTypes?: ReadonlyMap<string, unknown>) =>
    renderToStaticMarkup(
      <StructuredValue
        value={value}
        schema={schema === undefined ? undefined : valueSchema(schema, valueTypes)}
      />
    )

  test("keeps shape heuristics for open values nobody declared", () => {
    expect(render({ room: refShaped })).toContain(objectRefMarker)
    expect(render({ scan: fileRef })).toContain(fileMarker)
  })

  test("renders a user record shaped like a reference as the record it is", () => {
    const schema = fieldRecordSchema({
      room: {
        schema: {
          type: "object",
          properties: { objectTypeId: { schema: "string" }, primaryId: { schema: "string" } },
        },
      },
    })
    const markup = render({ room: refShaped }, schema)
    expect(markup).not.toContain(objectRefMarker)
    expect(markup).toContain("objectTypeId")
    expect(markup).toContain("room-1")
  })

  test("renders a FileRef-shaped record declared as something else without a file card", () => {
    const schema = fieldRecordSchema({
      blob: { schema: { type: "map", keySchema: "string", valueSchema: "string" } },
    })
    expect(render({ blob: fileRef }, schema)).not.toContain(fileMarker)
  })

  test("renders declared refs and files, through value types and containers", () => {
    const schema = fieldRecordSchema({
      rooms: { schema: { type: "array", items: { type: "objectRef", objectTypeId: "Room" } } },
      scan: { schema: { type: "valueTypeRef", valueTypeId: "Scan" } },
    })
    const markup = render(
      { rooms: [refShaped], scan: fileRef },
      schema,
      new Map([["Scan", "fileRef"]])
    )
    expect(markup).toContain(objectRefMarker)
    expect(markup).toContain(fileMarker)
  })

  test("never guesses below a position the schema does not describe", () => {
    const schema = fieldRecordSchema({ title: "string" })
    // An undeclared field and an unresolvable value type are unknown, not open.
    expect(render({ title: "t", extra: refShaped }, schema)).not.toContain(objectRefMarker)
    expect(
      render(
        { scan: fileRef },
        fieldRecordSchema({ scan: { type: "valueTypeRef", valueTypeId: "Scan" } })
      )
    ).not.toContain(fileMarker)
  })

  test("renders declared users as user chips, and never guesses one by shape", () => {
    const user = { type: "user", id: "usr_1" }
    // Only the user chip and its debug form draw the sky user icon.
    const userMarker = "text-sky-600"
    const schema = fieldRecordSchema({
      assignee: "userRef",
      reviewers: { type: "array", items: "userRef" },
    })
    const markup = render({ assignee: user, reviewers: [user] }, schema)
    expect(markup.split(userMarker)).toHaveLength(3)
    expect(markup).toContain("usr_1")
    expect(
      renderToStaticMarkup(
        <StructuredValue value={{ assignee: user }} schema={valueSchema(schema)} variant="debug" />
      )
    ).toContain(userMarker)

    expect(render({ assignee: user })).not.toContain(userMarker)
    const record = fieldRecordSchema({
      assignee: {
        type: "object",
        properties: { type: { schema: "string" }, id: { schema: "string" } },
      },
    })
    expect(render({ assignee: user }, record)).not.toContain(userMarker)
    expect(render({ assignee: "usr_1" }, schema)).not.toContain(userMarker)
  })

  test("renders a declared ref whose value does not match as a plain value", () => {
    const schema = fieldRecordSchema({ room: { type: "objectRef", objectTypeId: "Room" } })
    const markup = render({ room: "room-1" }, schema)
    expect(markup).not.toContain(objectRefMarker)
    expect(markup).toContain("room-1")
  })
})
