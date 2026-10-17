import { Button, DataTable, type DataTableColumn, Markdown } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { Download, ExternalLink, File as FileIcon } from "lucide-react"
import { useMemo } from "react"
import { formatFileSize } from "../file-size"
import type { FileSource } from "../file-source"
import { fileView } from "../file-view"
import { type ArtifactMessages, useArtifactMessages } from "../messages"
import { useFileText } from "../queries"
import { DelimitedTextParseError, type DelimitedTextPreview, parseDelimitedText } from "./delimited"
import { ViewerLoading, ViewerNotice } from "./notice"

/**
 * One file as its type allows: images, PDFs, Markdown, tables, and plain text in place, anything
 * else as a card to download it. File artifacts, message attachments, and files a tool returned
 * all open here.
 */
export function FileRenderer({ source }: { readonly source: FileSource }) {
  const view = fileView(source.fileRef)
  switch (view) {
    case "image":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4 sm:p-8">
          <img
            src={source.inlineUrl}
            alt={source.name}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      )
    case "pdf":
      return <PdfFile source={source} />
    case "markdown":
    case "text":
      return <TextFile source={source} markdown={view === "markdown"} />
    case "csv":
    case "tsv":
      return <TableFile source={source} kind={view} />
    case "download":
      return <DownloadCard source={source} />
  }
}

function TextFile({ source, markdown }: { source: FileSource; markdown: boolean }) {
  const messages = useArtifactMessages().files
  const file = useFileText(source)
  if (file.tooLarge) return <DownloadCard source={source} tooLarge />
  if (file.loading) return <ViewerLoading label={messages.loading} />
  if (file.error || file.text === undefined) {
    return <ViewerNotice title={file.error ? messages[file.error] : messages.noText} />
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {markdown ? (
        <Markdown className="mx-auto max-w-3xl px-6 py-8 sm:px-10 sm:py-12">{file.text}</Markdown>
      ) : (
        <pre className="m-0 px-6 py-6 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words text-foreground">
          {file.text}
        </pre>
      )}
    </div>
  )
}

type Row = readonly string[]

function TableFile({ source, kind }: { source: FileSource; kind: "csv" | "tsv" }) {
  const messages = useArtifactMessages().files
  const file = useFileText(source)
  const parsed = useMemo(() => parseTable(file.text, kind, messages), [file.text, kind, messages])
  const rows = useMemo(() => [...(parsed.data?.rows ?? [])], [parsed.data])
  const columns = useMemo<DataTableColumn<Row>[]>(
    () =>
      (parsed.data?.headers ?? []).map((header, index) => ({
        id: String(index),
        header,
        accessor: (row) => row[index] ?? "",
      })),
    [parsed.data]
  )

  if (file.tooLarge) return <DownloadCard source={source} tooLarge />
  if (file.loading) return <ViewerLoading label={messages.loading} />
  if (file.error)
    return <ViewerNotice title={messages.tableFailed} description={messages[file.error]} />
  if (!parsed.data) {
    return (
      <ViewerNotice title={messages.tableFailed} description={parsed.error ?? messages.malformed} />
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {parsed.data.rowsTruncated ? (
        <p
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
          role="status"
        >
          {messages.showing(parsed.data.rows.length, parsed.data.totalRows)}
        </p>
      ) : null}
      <DataTable columns={columns} data={rows} showRowIndex className="min-h-0 flex-1" />
    </div>
  )
}

function parseTable(
  text: string | undefined,
  kind: "csv" | "tsv",
  messages: ArtifactMessages["files"]
): { readonly data: DelimitedTextPreview | null; readonly error: string | null } {
  if (text === undefined) return { data: null, error: null }
  try {
    return { data: parseDelimitedText(text, kind, messages.column), error: null }
  } catch (error) {
    if (!(error instanceof DelimitedTextParseError))
      return { data: null, error: messages.malformed }
    if (error.reason === "empty") return { data: null, error: messages.emptyFile }
    if (error.reason === "no-header") return { data: null, error: messages.noHeader }
    return {
      data: null,
      error: error.row === undefined ? messages.malformed : messages.malformedNear(error.row),
    }
  }
}

function PdfFile({ source }: { source: FileSource }) {
  const messages = useArtifactMessages()
  return (
    <object
      data={source.inlineUrl}
      type="application/pdf"
      title={source.name}
      className="flex min-h-0 w-full flex-1 bg-muted/30"
    >
      <ViewerNotice
        title={messages.files.pdfUnavailable}
        description={messages.files.pdfDescription}
        action={
          <div className="flex justify-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={source.inlineUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                {messages.viewer.openInNewTab(source.name)}
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={source.downloadUrl} download={source.name}>
                <Download />
                {messages.viewer.downloadLabel}
              </a>
            </Button>
          </div>
        }
      />
    </object>
  )
}

function DownloadCard({ source, tooLarge = false }: { source: FileSource; tooLarge?: boolean }) {
  const messages = useArtifactMessages()
  const locale = useLocale()
  return (
    <ViewerNotice
      icon={
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <FileIcon className="size-6" aria-hidden="true" />
        </span>
      }
      title={tooLarge ? messages.files.tooLarge : messages.files.noPreview}
      description={`${source.name} · ${formatFileSize(source.fileRef.sizeBytes, locale, messages.files)}`}
      action={
        <Button size="sm" asChild>
          <a
            href={source.downloadUrl}
            download={source.name}
            aria-label={messages.viewer.download(source.name)}
          >
            <Download />
            {messages.viewer.downloadLabel}
          </a>
        </Button>
      }
    />
  )
}
