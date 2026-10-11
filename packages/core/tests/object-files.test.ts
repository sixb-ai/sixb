import { describe, expect, spyOn, test } from "bun:test"
import {
  AuthorizationError,
  can,
  defineGroup,
  defineMarking,
  defineObjectType,
  defineRole,
  type OpenedFileRef,
  prop,
  resolveAuthorizationContext,
  SixbHost,
} from "../src"
import { resolveFileRefAtPath } from "../src/blob-storage/internal"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

const legal = defineMarking("legal")

const Organization = defineObjectType({
  id: "organization",
  name: "Organization",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string"),
    prop("logo", "fileRef"),
    prop("contract", "fileRef", { markings: [legal] }),
    prop("documents", { type: "array", items: "fileRef" }),
  ],
})

const Supplier = defineObjectType({
  id: "supplier",
  name: "Supplier",
  properties: [prop("id", "string", { required: true, primary: true }), prop("logo", "fileRef")],
})

const staff = defineGroup("staff")
const counsel = defineGroup("counsel")

const encoder = new TextEncoder()

async function seed() {
  const host = new SixbHost({
    id: "object-files",
    ontology: [Organization, Supplier],
    markings: [legal],
    groups: [staff, counsel],
    roles: [
      defineRole("organization-reader", {
        grantedTo: [staff, counsel],
        grants: [can.view(Organization)],
      }),
      defineRole("counsel-clearance", { grantedTo: [counsel], clearances: [legal] }),
    ],
    ...createTestRuntimeDeps(),
  })
  const put = (text: string, fileName: string) =>
    host.blobStorage.put({ body: encoder.encode(text), fileName, mediaType: "text/plain" })
  const trusted = createTestSixb(host)
  await trusted.objects(Organization).upsert({
    properties: {
      id: "acme",
      name: "Acme",
      logo: await put("logo", "logo.txt"),
      contract: await put("contract", "contract.txt"),
      documents: [await put("first", "first.txt"), await put("second", "second.txt")],
    },
  })
  await trusted.objects(Organization).upsert({ properties: { id: "empty", name: "Empty" } })
  await trusted.objects(Supplier).upsert({
    properties: { id: "supplier-1", logo: await put("supplier", "supplier.txt") },
  })
  const readerIn = (groupIds: readonly string[]) =>
    createTestSixb(host, {
      authorization: resolveAuthorizationContext({
        principal: { type: "user", id: `user-${groupIds.join("-")}` },
        groupIds,
        roles: host.definitions.security.listResolvedRoles(),
      }),
    })
  return { host, trusted, staffReader: readerIn([staff.id]), counselReader: readerIn([counsel.id]) }
}

async function contents(file: OpenedFileRef | null) {
  if (!file) return null
  const { fileName, mediaType, sizeBytes } = file.fileRef
  return { fileName, mediaType, sizeBytes, text: await new Response(file.body).text() }
}

describe("object file reads", () => {
  test("opens a file property through the object that holds it", async () => {
    const { staffReader } = await seed()

    const logo = await staffReader
      .objects(Organization)
      .byId("acme")
      .file(Organization.p.logo)
      .open()
    expect(await contents(logo)).toEqual({
      fileName: "logo.txt",
      mediaType: "text/plain",
      sizeBytes: 4,
      text: "logo",
    })
  })

  // Regression proof: open the blob in openFileRef() rather than on the body's first read; the
  // spy then records the open before anything reads the body.
  test("opens the stored blob only when the body is read", async () => {
    const { host, staffReader } = await seed()
    const openBlob = spyOn(host.blobStorage, "open")

    const logo = await staffReader
      .objects(Organization)
      .byId("acme")
      .file(Organization.p.logo)
      .open()
    expect(openBlob).not.toHaveBeenCalled()
    expect(await new Response(logo?.body).text()).toBe("logo")
    expect(openBlob).toHaveBeenCalledTimes(1)
  })

  test("opens one file of a list by its index", async () => {
    const { staffReader } = await seed()
    const acme = staffReader.objects(Organization).byId("acme")

    expect((await contents(await acme.file(Organization.p.documents, 1).open()))?.text).toBe(
      "second"
    )
    expect(await acme.file(Organization.p.documents, 2).open()).toBeNull()
  })

  test("returns null when the object, the value or the blob is absent", async () => {
    const { host, trusted, staffReader } = await seed()
    const organizations = staffReader.objects(Organization)

    expect(await organizations.byId("missing").file(Organization.p.logo).open()).toBeNull()
    expect(await organizations.byId("empty").file(Organization.p.logo).open()).toBeNull()

    // A FileRef that no longer matches its stored blob is not served.
    const stored = await host.blobStorage.put({ body: encoder.encode("other") })
    await trusted.objects(Organization).upsert({
      properties: { id: "stale", logo: { ...stored, sizeBytes: stored.sizeBytes + 1 } },
    })
    expect(await organizations.byId("stale").file(Organization.p.logo).open()).toBeNull()
  })

  // Regression proof: drop the redaction check in objects/sdk/file-handle.ts; the redacted row has
  // no contract, so the uncleared reader gets null instead of an error.
  test("requires clearance for a marked file property", async () => {
    const { staffReader, counselReader } = await seed()

    await expect(
      staffReader.objects(Organization).byId("acme").file(Organization.p.contract).open()
    ).rejects.toThrow(AuthorizationError)
    const contract = await counselReader
      .objects(Organization)
      .byId("acme")
      .file(Organization.p.contract)
      .open()
    expect((await contents(contract))?.text).toBe("contract")
  })

  // Regression proof: read the row from `ctx.storage.objects` instead of `ctx.objectReader` in
  // objects/sdk/file-handle.ts; the reader then opens a file of a type it cannot view.
  test("requires the view grant of the object's type", async () => {
    const { staffReader } = await seed()

    await expect(
      staffReader.objects(Supplier).byId("supplier-1").file(Supplier.p.logo).open()
    ).rejects.toThrow(AuthorizationError)
  })

  test("rejects a property that does not hold files, or a misused index", async () => {
    const { trusted } = await seed()
    const acme = trusted.objects(Organization).byId("acme")
    const untyped = acme as unknown as {
      file(property: unknown, index?: number): unknown
    }

    expect(() => untyped.file(Organization.p.name)).toThrow("is not a file")
    expect(() => untyped.file(Organization.p.documents)).toThrow("pass the index")
    expect(() => untyped.file(Organization.p.logo, 0)).toThrow("omit the index")
    expect(() => untyped.file(Supplier.p.logo)).toThrow("cannot be used with organization")
  })

  test("resolves FileRefs only through own JSON pointer properties", async () => {
    const { host } = await seed()
    const fileRef = await host.blobStorage.put({ body: encoder.encode("file") })

    expect(resolveFileRefAtPath({ properties: { pdf: fileRef } }, "/properties/pdf")).toEqual(
      fileRef
    )
    const inheritedObject = Object.create({ properties: { pdf: fileRef } }) as unknown
    expect(resolveFileRefAtPath(inheritedObject, "/properties/pdf")).toBeNull()
    const sparseArray = [] as unknown[]
    Object.setPrototypeOf(sparseArray, { 0: fileRef })
    expect(resolveFileRefAtPath({ files: sparseArray }, "/files/0")).toBeNull()
  })
})
