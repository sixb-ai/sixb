import { useUploadFile } from "@sixb/client/hooks"
import { type FileRef, fileNameFor, isFileRef } from "@sixb/core/blob-storage"
import { Button } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { CheckCircle2, FileIcon, FileUp, Loader2, X } from "lucide-react"
import { type ChangeEvent, type DragEvent, useEffect, useId, useRef, useState } from "react"
import { fileMediaLabel, formatFileSize } from "../lib/files"

export function FileRefUploadField({
  value,
  onChange,
  id,
  errorId,
  disabled,
  logicalPathPrefix,
  onPendingChange,
}: {
  readonly value: FileRef | null
  readonly onChange: (fileRef: FileRef | null) => void
  readonly id?: string
  readonly errorId?: string
  readonly disabled?: boolean
  readonly logicalPathPrefix?: string
  readonly onPendingChange?: (pending: boolean) => void
}) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const inputRef = useRef<HTMLInputElement>(null)
  const activeRef = useRef(true)
  const onPendingChangeRef = useRef(onPendingChange)
  const [dragging, setDragging] = useState(false)
  const [uploadingFileName, setUploadingFileName] = useState<string | null>(null)
  const upload = useUploadFile()
  const isBusy = upload.isPending
  const isDisabled = disabled || isBusy
  const uploadErrorId = upload.error ? `${inputId}-upload-error` : undefined
  const describedBy = [errorId, uploadErrorId].filter(Boolean).join(" ") || undefined

  useEffect(() => {
    onPendingChangeRef.current = onPendingChange
  }, [onPendingChange])

  useEffect(() => {
    activeRef.current = true
    return () => {
      activeRef.current = false
    }
  }, [])

  useEffect(() => {
    onPendingChangeRef.current?.(isBusy)
    return () => onPendingChangeRef.current?.(false)
  }, [isBusy])

  async function uploadSelectedFile(file: File) {
    upload.reset()
    setUploadingFileName(file.name)

    try {
      const fileRef = await upload.mutateAsync({
        file,
        logicalPath: logicalPathPrefix
          ? `${logicalPathPrefix.replace(/\/$/, "")}/${file.name}`
          : file.name,
      })
      if (activeRef.current) {
        onChange(fileRef)
      }
    } catch {
      // The mutation stores the error for rendering below.
    } finally {
      setUploadingFileName(null)
      setDragging(false)
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) return
    await uploadSelectedFile(file)
  }

  function openFilePicker() {
    if (isDisabled) return
    inputRef.current?.click()
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (!isDisabled) {
      event.dataTransfer.dropEffect = "copy"
      setDragging(true)
    }
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragging(false)
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragging(false)
    if (isDisabled) return

    const file = event.dataTransfer.files?.[0]
    if (file) {
      void uploadSelectedFile(file)
    }
  }

  const fileName = value ? fileNameFor(value) : null
  const mediaLabel = value && fileName ? fileMediaLabel(value.mediaType, fileName) : null

  return (
    <div className="w-full min-w-0 space-y-2">
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        onChange={handleFileChange}
        disabled={isDisabled}
        aria-describedby={describedBy}
        className="sr-only"
      />

      {value && fileName && mediaLabel ? (
        <div className="flex w-full min-w-0 max-w-full flex-col gap-3 overflow-hidden rounded-lg border border-border bg-background p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-300">
              <CheckCircle2 className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground" title={fileName}>
                {fileName}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {mediaLabel} · {formatFileSize(value.sizeBytes)} · Ready to submit
              </p>
            </div>
          </div>
          <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openFilePicker}
              disabled={isDisabled}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                upload.reset()
                onChange(null)
              }}
              disabled={isDisabled}
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Clear ${fileName}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "w-full min-w-0 max-w-full overflow-hidden rounded-lg border border-dashed bg-muted/10 p-4 transition-colors",
            dragging
              ? "border-primary/60 bg-primary/5"
              : "border-border/80 hover:border-border hover:bg-muted/20",
            isDisabled && "pointer-events-none opacity-70"
          )}
        >
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground shadow-xs ring-1 ring-border">
                {isBusy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <FileUp className="h-5 w-5" />
                )}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="truncate text-sm font-medium text-foreground">
                  {isBusy ? `Uploading ${uploadingFileName ?? "file"}...` : "Drop a file here"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {isBusy
                    ? "Keep this dialog open while the upload finishes."
                    : "Or browse to upload now and store the FileRef on submit."}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openFilePicker}
              disabled={isDisabled}
              className="shrink-0"
            >
              <FileIcon className="h-4 w-4" />
              Choose file
            </Button>
          </div>
        </div>
      )}

      {upload.error ? (
        <p id={uploadErrorId} role="alert" className="text-xs text-destructive">
          {errorToMessage(upload.error)}
        </p>
      ) : null}
    </div>
  )
}

export function parseFileRefFormValue(value: string | undefined): FileRef | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isFileRef(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function stringifyFileRefFormValue(fileRef: FileRef): string {
  return JSON.stringify(fileRef)
}

function errorToMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string") return error.message
  if (isRecord(error) && typeof error.error === "string") return error.error
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Could not upload file."
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
