import { describe, expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { renderToStaticMarkup } from "react-dom/server"
import { fieldRecordSchema, runFileLinks, ValuePanel, valueSchema } from "../src/pages/values"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
}
const refShaped = { objectTypeId: "Room", primaryId: "room-1" }
// Only a file card draws the file icon, an object reference the box, and a user the round user.
const fileMarker = "lucide-file"
const objectMarker = "lucide-box"
const userMarker = "lucide-user-round"

const render = (value: unknown, schema?: unknown, valueTypes?: ReadonlyMap<string, unknown>) =>
  renderToStaticMarkup(
    <ValuePanel
      title="Value"
      value={value}
      schema={schema === undefined ? undefined : valueSchema(schema, valueTypes)}
    />
  )

describe("a recorded value", () => {
  test("recognizes references and files by shape when nobody declared it", () => {
    expect(render({ room: refShaped })).toContain(objectMarker)
    expect(render({ scan: fileRef })).toContain(fileMarker)
  })

  // Regression proof: let readPosition fall back to shapes under a schema and these turn into a
  // reference chip and a file card.
  test("draws a record shaped like a reference or a file as the record it was declared", () => {
    const room = fieldRecordSchema({
      room: {
        schema: {
          type: "object",
          properties: { objectTypeId: { schema: "string" }, primaryId: { schema: "string" } },
        },
      },
    })
    const markup = render({ room: refShaped }, room)
    expect(markup).not.toContain(objectMarker)
    expect(markup).toContain("room-1")
    const blob = fieldRecordSchema({
      blob: { schema: { type: "map", keySchema: "string", valueSchema: "string" } },
    })
    expect(render({ blob: fileRef }, blob)).not.toContain(fileMarker)
  })

  test("follows declared references and files through value types and lists", () => {
    const schema = fieldRecordSchema({
      rooms: { schema: { type: "array", items: { type: "objectRef", objectTypeId: "Room" } } },
      scan: { schema: { type: "valueTypeRef", valueTypeId: "Scan" } },
    })
    const markup = render(
      { rooms: [refShaped], scan: fileRef },
      schema,
      new Map([["Scan", "fileRef"]])
    )
    expect(markup).toContain(objectMarker)
    expect(markup).toContain(fileMarker)
  })

  test("never guesses below a position the schema does not describe", () => {
    // An undeclared field and an unresolvable value type are unknown, not open.
    expect(
      render({ title: "t", extra: refShaped }, fieldRecordSchema({ title: "string" }))
    ).not.toContain(objectMarker)
    expect(
      render(
        { scan: fileRef },
        fieldRecordSchema({ scan: { type: "valueTypeRef", valueTypeId: "Scan" } })
      )
    ).not.toContain(fileMarker)
  })

  test("draws a user only where one is declared, and a mismatched value as itself", () => {
    const user = { type: "user", id: "usr_1" }
    const schema = fieldRecordSchema({ assignee: "userRef" })
    expect(render({ assignee: user }, schema)).toContain(userMarker)
    expect(render({ assignee: user })).not.toContain(userMarker)
    expect(render({ assignee: "usr_1" }, schema)).not.toContain(userMarker)
    const room = fieldRecordSchema({ room: { type: "objectRef", objectTypeId: "Room" } })
    const markup = render({ room: "room-1" }, room)
    expect(markup).not.toContain(objectMarker)
    expect(markup).toContain("room-1")
  })

  test("says it is empty in the panel's words when nothing was recorded", () => {
    for (const value of [null, {}, []]) {
      expect(
        renderToStaticMarkup(<ValuePanel title="Input" value={value} emptyLabel="No input" />)
      ).toContain("No input")
    }
  })
})

// Regression proof: drop the `~` and `/` escapes in runFileLinks and the server reads another path.
test("links a file to its run as a JSON pointer below the value's root", () => {
  const links = runFileLinks("https://app.test", "/api/workflow-runs/wf%2F1/files/content", "input")
  expect(links(["input~file", "a/b"])).toEqual({
    inlineUrl:
      "https://app.test/api/workflow-runs/wf%2F1/files/content?path=%2Finput%2Finput%7E0file%2Fa%7E1b",
    downloadUrl:
      "https://app.test/api/workflow-runs/wf%2F1/files/content?path=%2Finput%2Finput%7E0file%2Fa%7E1b&disposition=attachment",
  })
})
