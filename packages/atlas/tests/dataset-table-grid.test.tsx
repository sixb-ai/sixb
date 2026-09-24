import { expect, test } from "bun:test"
import type { FileRef } from "@sixb/core/blob-storage"
import { renderToStaticMarkup } from "react-dom/server"
import { DatasetTableGrid } from "../src/features/datasets/DatasetTableGrid"

const fileRef: FileRef = {
  blobId: "blob_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  sizeBytes: 7789,
  fileName: "download.jpeg",
  mediaType: "image/jpeg",
}

test("dataset cells render files only in columns declared fileRef", () => {
  const markup = renderToStaticMarkup(
    <DatasetTableGrid
      columns={["attachment", "payload"]}
      columnMeta={
        new Map([
          ["attachment", { type: "fileRef?", numeric: false }],
          ["payload", { type: "json", numeric: false }],
        ])
      }
      rows={[{ attachment: fileRef, payload: fileRef }]}
      offset={0}
      isLoading={false}
      isError={false}
    />
  )
  // The file cell shows the file name with its size in the title; the json
  // cell shows the record itself.
  expect(markup).toContain("download.jpeg · JPEG image · 7.6 KB")
  expect(markup).toContain(`blobId: ${fileRef.blobId}`)
})
