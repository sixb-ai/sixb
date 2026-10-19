import { describe, expect, test } from "bun:test"
import { createSixbClient } from "@sixb/client"
import { ArtifactMovedError, publishEdit } from "../src/artifacts/publish-edit"
import type { ArtifactVersion } from "../src/artifacts/queries"

const fileRef = (name: string) => ({
  blobId: `blob_${name}`,
  digest: `sha256:${name.padEnd(64, "0")}`,
  sizeBytes: 10,
  mediaType: "text/csv",
  fileName: name,
})

const VERSION = {
  artifactId: "art_s3ll5ab0ok",
  version: 3,
  title: "Q3 operations",
  entry: "sheets/Regions.csv",
  files: [
    { path: "sheets/Regions.csv", file: fileRef("regions") },
    { path: "sheets/Quarters.csv", file: fileRef("quarters") },
    { path: "workbook.json", file: fileRef("workbook") },
  ],
  outline: { kind: "sheet", sheets: [] },
  references: [],
  author: { type: "user", id: "usr_ana" },
  createdAt: "2026-10-18T12:00:00.000Z",
} as unknown as ArtifactVersion

/** A client whose API records each request and answers the publish with `published`. */
function api(published: () => Response) {
  const requests: { url: string; body: unknown }[] = []
  const fetch = Object.assign(
    async (input: Request) => {
      const url = new URL(input.url).pathname
      if (url === "/api/files") {
        const form = await input.formData()
        const file = form.get("file") as File
        requests.push({ url, body: file.name })
        return Response.json(fileRef(`new-${file.name}`), { status: 201 })
      }
      requests.push({ url, body: await input.json() })
      return published()
    },
    { preconnect: globalThis.fetch.preconnect }
  ) as unknown as typeof globalThis.fetch
  return { client: createSixbClient({ baseUrl: "http://localhost:3002", fetch }), requests }
}

describe("publishing an edit", () => {
  test("uploads only what changed and carries the rest over from the version edited", async () => {
    const { client, requests } = api(() =>
      Response.json({ artifact: {}, version: { version: 4 }, warnings: [] }, { status: 201 })
    )
    const changed = new Map<string, Blob | null>([
      ["sheets/Regions.csv", new Blob(["Region,Visits\nNorth,1300\n"])],
      ["sheets/Quarters.csv", null],
      ["sheets/Targets.csv", new Blob(["Region,Target\n"])],
    ])
    await publishEdit(VERSION, changed, { client })

    // Two uploads, the edited sheet and the added one; the workbook is never sent again.
    expect(requests.filter((request) => request.url === "/api/files").map((r) => r.body)).toEqual([
      "Regions.csv",
      "Targets.csv",
    ])
    expect(requests.at(-1)).toEqual({
      url: "/api/artifacts/art_s3ll5ab0ok/versions",
      body: {
        kind: "sheet",
        title: "Q3 operations",
        baseVersion: 3,
        files: [
          { path: "sheets/Regions.csv", file: fileRef("new-Regions.csv") },
          { path: "workbook.json", file: fileRef("workbook") },
          { path: "sheets/Targets.csv", file: fileRef("new-Targets.csv") },
        ],
      },
    })
  })

  test("says who published when the artifact moved past the version edited", async () => {
    const { client } = api(() =>
      Response.json(
        {
          error: "[Sixb] Artifact 'art_s3ll5ab0ok' is at version 4, not version 3.",
          code: "artifact_moved",
          latest: { version: 4, author: { type: "user", id: "usr_mina" } },
        },
        { status: 409 }
      )
    )
    const saving = publishEdit(VERSION, new Map(), { client })
    await expect(saving).rejects.toBeInstanceOf(ArtifactMovedError)
    await expect(saving).rejects.toMatchObject({
      latest: { version: 4, author: { type: "user", id: "usr_mina" } },
    })
  })
})
