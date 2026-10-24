import { describe, expect, test } from "bun:test"
import type { GetUserResponse } from "@sixb/client"
import { userQueryOptions } from "@sixb/client/hooks"
import type { FileRef } from "@sixb/core/blob-storage"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
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

// An object reference links to its object's page, so the panel needs a router. A user reference
// reads the member directory, so it needs a query client too.
const markup = (node: ReactNode, queryClient = new QueryClient()) =>
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  )

const render = (value: unknown, schema?: unknown, valueTypes?: ReadonlyMap<string, unknown>) =>
  markup(
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

  test("names a user from the member directory, and shows the id until it can", () => {
    const schema = valueSchema(fieldRecordSchema({ assignee: "userRef", reviewer: "userRef" }))
    const value = {
      assignee: { type: "user", id: "usr_1" },
      reviewer: { type: "user", id: "usr_2" },
    }
    const queryClient = new QueryClient()
    const ava: GetUserResponse = {
      id: "usr_1",
      email: "ava@acme.com",
      displayName: "Ava Martin",
      status: "active",
    }
    const ben: GetUserResponse = { id: "usr_2", email: "ben@acme.com", status: "suspended" }
    // The member picker's lookup: a member it named names the chip too. Removal proof: give the
    // chip a query of its own and it shows the ids.
    queryClient.setQueryData(userQueryOptions(ava.id).queryKey, ava)
    queryClient.setQueryData(userQueryOptions(ben.id).queryKey, ben)

    const named = markup(<ValuePanel title="Value" value={value} schema={schema} />, queryClient)
    expect(named).toContain("Ava Martin")
    expect(named).toContain('title="ava@acme.com · usr_1"')
    expect(named).toContain("ben@acme.com")
    expect(named).toContain("Suspended")

    // Refused or unknown: cached as no one, so the chip keeps the id without asking again.
    const refused = new QueryClient()
    refused.setQueryData(userQueryOptions("usr_1").queryKey, null)
    expect(markup(<ValuePanel title="Value" value={value} schema={schema} />, refused)).toContain(
      ">usr_1<"
    )

    // Not loaded, denied or unknown: the chip it always was.
    const unnamed = markup(<ValuePanel title="Value" value={value} schema={schema} />)
    expect(unnamed).toContain(">usr_1<")
    expect(unnamed).not.toContain("Ava Martin")
  })

  test("says it is empty in the panel's words when nothing was recorded", () => {
    for (const value of [null, {}, []]) {
      expect(markup(<ValuePanel title="Input" value={value} emptyLabel="No input" />)).toContain(
        "No input"
      )
    }
  })
})

test("links a file to its run as a JSON pointer below the value's root", () => {
  const links = runFileLinks("https://api.test", "/api/workflow-runs/wf%2F1/files/content", "input")
  const url = links(["input~file", "a/b"], fileRef)
  // Regression proof: drop the `~` and `/` escapes in runFileLinks and the server reads another path.
  expect(url?.inlineUrl).toBe(
    "https://api.test/api/workflow-runs/wf%2F1/files/content?path=%2Finput%2Finput%7E0file%2Fa%7E1b"
  )
  expect(url?.downloadUrl).toBe(
    "https://api.test/api/workflow-runs/wf%2F1/files/content?path=%2Finput%2Finput%7E0file%2Fa%7E1b&disposition=attachment"
  )
})

test("links a reference to the object's page, its type and id each escaped", () => {
  const html = render(
    { room: { objectTypeId: "Room", primaryId: "a/b c" } },
    fieldRecordSchema({ room: { type: "objectRef", objectTypeId: "Room" } })
  )
  expect(html).toContain('href="/objects/Room/a%2Fb%20c"')
})

// Regression proof: format `integer` with Intl.NumberFormat in formatPrimitive and the year reads
// "2,026".
test("keeps an integer's digits as written, and groups a decimal's", () => {
  const html = render(
    { year: 2026, revenue: 1234567.5 },
    fieldRecordSchema({ year: "integer", revenue: "double" })
  )
  expect(html).toContain(">2026<")
  expect(html).toContain("1,234,567.5")
})
