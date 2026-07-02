import { randomUUID } from "node:crypto"
import { defineWorkflow, defineWorkflowStep, ref } from "@sixb/core"
import { stringEnum } from "@sixb/core/ontology"
import { Document } from "../ontology/document"

const documentTypeSchema = stringEnum([
  "proposal",
  "contract",
  "specification",
  "report",
  "deliverable",
])
type DocumentType = (typeof documentTypeSchema)["values"][number]

const classifyUploadedDocument = defineWorkflowStep("classify-uploaded-document")
  .input({
    title: "string",
    sourceFile: "fileRef",
  })
  .output({
    title: "string",
    sourceFile: "fileRef",
    documentType: documentTypeSchema,
    summary: "string",
  })
  .run(async ({ input }) => {
    await wait(500)

    const fileName = input.sourceFile.fileName ?? input.sourceFile.logicalPath ?? "uploaded file"
    const mediaType = input.sourceFile.mediaType ?? "application/octet-stream"
    const documentType = documentTypeFor(mediaType, fileName)

    return {
      title: input.title,
      sourceFile: input.sourceFile,
      documentType,
      summary: `Uploaded ${fileName} (${mediaType}, ${input.sourceFile.sizeBytes.toLocaleString()} bytes) for document intake.`,
    }
  })

const registerUploadedDocument = defineWorkflowStep("register-uploaded-document")
  .input({
    title: "string",
    sourceFile: "fileRef",
    documentType: documentTypeSchema,
    summary: "string",
  })
  .output({
    document: ref(Document),
    sourceFile: "fileRef",
    summary: "string",
  })
  .run(async ({ input, sixb }) => {
    await wait(650)

    const documentId = `doc-upload-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    await sixb.objects(Document).upsert({
      properties: {
        id: documentId,
        title: input.title,
        type: input.documentType,
        version: "manual-upload",
        createdAt: new Date().toISOString(),
        attachment: input.sourceFile,
      },
    })

    return {
      document: { objectTypeId: Document.id, primaryId: documentId },
      sourceFile: input.sourceFile,
      summary: input.summary,
    }
  })

export const documentIntakeWorkflow = defineWorkflow("document-intake-workflow")
  .input({
    title: "string",
    sourceFile: "fileRef",
  })
  .then(classifyUploadedDocument)
  .then(registerUploadedDocument)

function documentTypeFor(mediaType: string, fileName: string): DocumentType {
  const normalized = mediaType.toLowerCase()
  const lowerName = fileName.toLowerCase()

  if (normalized === "application/pdf" || lowerName.endsWith(".pdf")) {
    return "report"
  }
  if (normalized.startsWith("image/")) {
    return "deliverable"
  }
  if (lowerName.includes("contract")) {
    return "contract"
  }
  return "specification"
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
