import { describe, expect, test } from "bun:test"
import { InMemoryBlobStorage } from "@sixb/core"
import { attachInvoiceSourceFile } from "../actions/attachInvoiceSourceFile"
import { erpDocumentsDataset } from "../datasets/erp"
import { createSampleAttachmentForDocument } from "../lib/sample-files"
import { documentProjection } from "../projections/document-projection"
import { documentIntakeWorkflow } from "../workflows/document-intake"

describe("Acme document file attachments", () => {
  test("stores sample ERP document attachments as FileRefs", async () => {
    const blobs = new InMemoryBlobStorage()
    const pdf = await createSampleAttachmentForDocument(blobs, "doc-techstart-proposal")
    const image = await createSampleAttachmentForDocument(blobs, "doc-greenenergy-spec")

    expect(pdf).toMatchObject({
      fileName: "techstart-platform-proposal.pdf",
      mediaType: "application/pdf",
      logicalPath: "acme-erp/documents/techstart-platform-proposal.pdf",
    })
    expect(image).toMatchObject({
      fileName: "greenenergy-dashboard-preview.png",
      mediaType: "image/png",
      logicalPath: "acme-erp/documents/greenenergy-dashboard-preview.png",
    })

    const pdfBytes = await new Response(await blobs.open(pdf!.blobId)).arrayBuffer()
    const imageBytes = new Uint8Array(
      await new Response(await blobs.open(image!.blobId)).arrayBuffer()
    )

    expect(new TextDecoder().decode(pdfBytes.slice(0, 8))).toBe("%PDF-1.4")
    expect([...imageBytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    await expect(createSampleAttachmentForDocument(blobs, "doc-without-attachment")).resolves.toBe(
      undefined
    )
  })

  test("maps ERP document attachment rows into Document objects", () => {
    expect(erpDocumentsDataset.schema.columns).toContainEqual({
      name: "attachment",
      type: "fileRef",
      nullable: true,
    })
    expect(documentProjection.properties).toMatchObject({
      attachment: "attachment",
    })
  })

  test("exposes manual action and workflow file inputs for Atlas testing", () => {
    expect(attachInvoiceSourceFile.params.sourceFile).toMatchObject({
      schema: "fileRef",
      required: true,
    })
    expect(documentIntakeWorkflow.input).toMatchObject({
      title: "string",
      sourceFile: "fileRef",
    })
    expect(documentIntakeWorkflow.nodes.map((node) => node.key)).toEqual([
      "classifyUploadedDocument",
      "registerUploadedDocument",
    ])
    const [classifyNode, registerNode] = documentIntakeWorkflow.nodes
    expect(classifyNode?.type === "step" ? classifyNode.step.output.sourceFile : undefined).toBe(
      "fileRef"
    )
    expect(registerNode?.type === "step" ? registerNode.step.output.sourceFile : undefined).toBe(
      "fileRef"
    )
  })
})
