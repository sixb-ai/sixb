import { CsvParseError, parseCsv } from "@sixb/core/artifacts"
import { Button, Markdown } from "@sixb/ui/components"
import { useLocale } from "@sixb/ui/lib/i18n"
import { Download, ExternalLink, File as FileIcon } from "lucide-react"
import { useMemo } from "react"
import { formatFileSize } from "../file-size"
import { type FileSource, useFileName } from "../file-source"
import { fileView } from "../file-view"
import { useArtifactMessages } from "../messages"
import { useFileText } from "../queries"
import { ViewerLoading, ViewerNotice } from "./notice"
import { fileSheetModel } from "./sheet/model"
import { SheetTable } from "./sheet/sheet"

/**
 * One file as its type allows: images, PDFs, Markdown, tables, and plain text in place, anything
 * else as a card to download it. File artifacts, message attachments, and files a tool returned
 * all open here.
 */
export function FileRenderer({ source }: { readonly source: FileSource }) {
  const view = fileView(source.fileRef)
  const name = useFileName(source)
  switch (view) {
    case "image":
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/30 p-4 sm:p-8">
          <img
            src={source.inlineUrl}
            alt={name}
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      )
    case "pdf":
      return <PdfFile source={source} name={name} />
    case "markdown":
    case "text":
      return <TextFile source={source} name={name} markdown={view === "markdown"} />
    case "csv":
    case "tsv":
      return <TableFile source={source} name={name} kind={view} />
    case "download":
      return <DownloadCard source={source} name={name} />
  }
}

interface FileProps {
  readonly source: FileSource
  /** The file's name as the reader sees it. */
  readonly name: string
}

function TextFile({ source, name, markdown }: FileProps & { readonly markdown: boolean }) {
  const messages = useArtifactMessages().files
  const file = useFileText(source)
  if (file.tooLarge) return <DownloadCard source={source} name={name} tooLarge />
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

function TableFile({ source, name, kind }: FileProps & { readonly kind: "csv" | "tsv" }) {
  const messages = useArtifactMessages().files
  const file = useFileText(source)
  const parsed = useMemo(() => {
    if (file.text === undefined) return null
    try {
      const table = parseCsv(file.text, { delimiter: kind === "tsv" ? "\t" : "," })
      if (table.header.length === 0) return { error: messages.emptyFile }
      return { model: fileSheetModel(name, table) }
    } catch (error) {
      if (error instanceof CsvParseError) return { error: messages.malformedNear(error.line) }
      throw error
    }
  }, [file.text, kind, name, messages])

  if (file.tooLarge) return <DownloadCard source={source} name={name} tooLarge />
  if (file.loading) return <ViewerLoading label={messages.loading} />
  if (file.error) {
    return <ViewerNotice title={messages.tableFailed} description={messages[file.error]} />
  }
  if (!parsed) return <ViewerLoading label={messages.loading} />
  if ("error" in parsed) {
    return <ViewerNotice title={messages.tableFailed} description={parsed.error} />
  }
  return <SheetTable model={parsed.model} />
}

function PdfFile({ source, name }: FileProps) {
  const messages = useArtifactMessages()
  return (
    <object
      data={source.inlineUrl}
      type="application/pdf"
      title={name}
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
                {messages.viewer.openInNewTab(name)}
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={source.downloadUrl} download={name}>
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

function DownloadCard({
  source,
  name,
  tooLarge = false,
}: FileProps & { readonly tooLarge?: boolean }) {
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
      description={`${name} · ${formatFileSize(source.fileRef.sizeBytes, locale, messages.files)}`}
      action={
        <Button size="sm" asChild>
          <a href={source.downloadUrl} download={name} aria-label={messages.viewer.download(name)}>
            <Download />
            {messages.viewer.downloadLabel}
          </a>
        </Button>
      }
    />
  )
}
