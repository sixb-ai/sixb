import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Markdown,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Spinner,
} from "@sixb/ui/components"
import { useIsMobile } from "@sixb/ui/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { Download, ExternalLink, FileWarning, X } from "lucide-react"
import {
  createContext,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from "react"
import { useDelimitedTextDocument, useHtmlDocument, useMarkdownDocument } from "./content"
import { DelimitedTextParseError, type DelimitedTextPreview, parseDelimitedText } from "./delimited"
import { buildSafeHtmlPreviewDocument, HTML_PREVIEW_SANDBOX } from "./html"
import {
  documentPreviewStorageKey,
  parseDocumentPreviewState,
  readDocumentPreviewState,
  writeDocumentPreviewState,
} from "./persistence"
import { documentPreviewPresentation } from "./presentation"
import { agentDocumentPreviewRenderer } from "./rendering"
import {
  type DocumentPreviewState,
  type DocumentTabNavigationKey,
  documentPreviewReducer,
  documentTabIdAfterKey,
  EMPTY_DOCUMENT_PREVIEW_STATE,
} from "./state"
import type { AgentDocumentSource } from "./types"

interface DocumentPreviewContextValue {
  readonly openDocument: (document: AgentDocumentSource) => void
}

interface DocumentViewerProps {
  readonly idPrefix: string
  readonly state: DocumentPreviewState
  readonly onSelect: (id: string) => void
  readonly onClose: (id: string) => void
  readonly onCloseAll: () => void
}

interface PreviewPanelHandle {
  collapse(): void
  expand(): void
  getSize(): { readonly asPercentage: number; readonly inPixels: number }
  isCollapsed(): boolean
  resize(size: number | string): void
}

const DocumentPreviewContext = createContext<DocumentPreviewContextValue | null>(null)

export function DocumentPreviewRoot({
  children,
  compact = false,
  scopeKey,
  persistenceKey,
}: {
  readonly children: ReactNode
  readonly compact?: boolean
  /** Selects the isolated preview state for the current conversation or draft. */
  readonly scopeKey?: string | null
  /** Persist open tabs, the active document, and panel width for a durable thread. */
  readonly persistenceKey?: string | null
}) {
  const idPrefix = useId()
  const previewScopeKey = persistenceKey ? `thread:${persistenceKey}` : `scope:${scopeKey ?? ""}`
  const restoredState = useMemo(
    () =>
      persistenceKey ? readDocumentPreviewState(persistenceKey) : EMPTY_DOCUMENT_PREVIEW_STATE,
    [persistenceKey]
  )
  const [state, dispatch] = useReducer(documentPreviewReducer, restoredState)
  const [revealVersion, revealDocument] = useReducer((version: number) => version + 1, 0)
  const openerRef = useRef<HTMLElement | null>(null)
  const revealScopeRef = useRef<string | null>(null)
  const stateScopeRef = useRef(previewScopeKey)
  const visibleState = stateScopeRef.current === previewScopeKey ? state : restoredState
  const activeDocument =
    visibleState.documents.find((document) => document.id === visibleState.activeId) ?? null
  const presentation = documentPreviewPresentation(compact, useIsMobile())

  useLayoutEffect(() => {
    stateScopeRef.current = previewScopeKey
    dispatch({ type: "restore", state: restoredState })
    openerRef.current = null
  }, [previewScopeKey, restoredState])

  useEffect(() => {
    if (!persistenceKey || stateScopeRef.current !== previewScopeKey || state !== visibleState)
      return
    writeDocumentPreviewState(persistenceKey, state)
  }, [persistenceKey, previewScopeKey, state, visibleState])

  useEffect(() => {
    if (!persistenceKey || typeof window === "undefined") return

    const storageKey = documentPreviewStorageKey(persistenceKey)
    const syncPreviewState = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || event.key !== storageKey) return
      dispatch({
        type: "restore",
        state: parseDocumentPreviewState(event.newValue, persistenceKey),
      })
    }

    window.addEventListener("storage", syncPreviewState)
    return () => window.removeEventListener("storage", syncPreviewState)
  }, [persistenceKey])

  const restoreOpenerFocus = useCallback(() => {
    const opener = openerRef.current
    openerRef.current = null
    if (!opener?.isConnected) return
    queueMicrotask(() => opener.focus())
  }, [])
  const openDocument = useCallback(
    (source: AgentDocumentSource) => {
      if (visibleState.documents.length === 0 && typeof window !== "undefined") {
        const activeElement = window.document.activeElement
        openerRef.current = activeElement instanceof HTMLElement ? activeElement : null
      }
      dispatch({ type: "open", document: source })
      revealScopeRef.current = previewScopeKey
      revealDocument()
    },
    [previewScopeKey, visibleState.documents.length]
  )
  const closeDocument = useCallback(
    (id: string) => {
      const closesLastDocument =
        visibleState.documents.length === 1 && visibleState.documents[0]?.id === id
      dispatch({ type: "close", id })
      if (closesLastDocument) restoreOpenerFocus()
    },
    [restoreOpenerFocus, visibleState.documents]
  )
  const closeAllDocuments = useCallback(() => {
    dispatch({ type: "close-all" })
    restoreOpenerFocus()
  }, [restoreOpenerFocus])
  const selectDocument = useCallback((id: string) => dispatch({ type: "select", id }), [])
  const savePanelWidth = useCallback(
    (width: number) => dispatch({ type: "set-panel-width", width }),
    []
  )
  const context = useMemo<DocumentPreviewContextValue>(() => ({ openDocument }), [openDocument])
  const viewerProps = useMemo<DocumentViewerProps>(
    () => ({
      idPrefix,
      state: visibleState,
      onSelect: selectDocument,
      onClose: closeDocument,
      onCloseAll: closeAllDocuments,
    }),
    [closeAllDocuments, closeDocument, idPrefix, selectDocument, visibleState]
  )

  return (
    <DocumentPreviewContext.Provider value={context}>
      {presentation === "panel" ? (
        <DocumentPreviewWorkspace
          revealKey={
            activeDocument ? `${previewScopeKey}:${activeDocument.id}:${revealVersion}` : null
          }
          scopeKey={previewScopeKey}
          panelWidth={visibleState.panelWidth}
          onPanelResize={savePanelWidth}
          focusActiveTab={revealVersion > 0 && revealScopeRef.current === previewScopeKey}
          viewerProps={viewerProps}
        >
          {children}
        </DocumentPreviewWorkspace>
      ) : (
        children
      )}
      <DocumentPreviewDialog
        open={presentation === "dialog" && activeDocument !== null}
        activeDocument={activeDocument}
        viewerProps={viewerProps}
      />
    </DocumentPreviewContext.Provider>
  )
}

export function useDocumentPreview(): DocumentPreviewContextValue | null {
  return useContext(DocumentPreviewContext)
}

// Keep the conversation wrapper stable while the document panel opens, closes, or changes tabs.
const ConversationPane = memo(function ConversationPane({ children }: { children: ReactNode }) {
  return <div className="h-full min-h-0 min-w-0">{children}</div>
})

function DocumentPreviewWorkspace({
  children,
  revealKey,
  scopeKey,
  panelWidth,
  onPanelResize,
  focusActiveTab,
  viewerProps,
}: {
  children: ReactNode
  revealKey: string | null
  scopeKey: string
  panelWidth: number | null
  onPanelResize: (width: number) => void
  focusActiveTab: boolean
  viewerProps: DocumentViewerProps
}) {
  const open = revealKey !== null
  const panelRef = useRef<PreviewPanelHandle | null>(null)
  const scopeRef = useRef(scopeKey)
  const appliedWidthRef = useRef<number | null>(null)
  const needsWidthRef = useRef(true)

  const persistPanelWidth = useCallback(() => {
    const size = panelRef.current?.getSize()
    if (!open || !size || size.inPixels <= 0) return

    const width = Math.round(size.inPixels)
    appliedWidthRef.current = width
    onPanelResize(width)
  }, [onPanelResize, open])

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    if (scopeRef.current !== scopeKey) {
      scopeRef.current = scopeKey
      appliedWidthRef.current = null
      needsWidthRef.current = true
    }

    if (revealKey === null) {
      panel.collapse()
      return
    }

    if (needsWidthRef.current || (panelWidth !== null && panelWidth !== appliedWidthRef.current)) {
      needsWidthRef.current = false
      appliedWidthRef.current = panelWidth
      panel.resize(panelWidth ?? "50%")
      return
    }

    // Reopening or clicking an already-open document should restore a pane the user collapsed by
    // dragging the separator. `revealKey` changes for a new scope, tab, or repeated file click.
    if (panel.isCollapsed()) panel.expand()
  }, [panelWidth, revealKey, scopeKey])

  return (
    <ResizablePanelGroup
      id="agent-document-workspace"
      orientation="horizontal"
      onLayoutChanged={persistPanelWidth}
      className="min-h-0"
    >
      <ResizablePanel id="agent-conversation" defaultSize="100%" minSize="30%">
        <ConversationPane>{children}</ConversationPane>
      </ResizablePanel>
      <ResizableHandle
        className={cn(
          "bg-transparent transition-opacity before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border/70 before:transition-[width,background-color] before:duration-150 hover:before:w-0.5 hover:before:bg-foreground/25 focus-visible:before:w-0.5 focus-visible:before:bg-ring active:before:w-[3px] active:before:bg-foreground/35",
          !open && "pointer-events-none invisible opacity-0"
        )}
      />
      <ResizablePanel
        id="agent-document-preview"
        defaultSize="0%"
        minSize="20rem"
        maxSize="65%"
        groupResizeBehavior="preserve-pixel-size"
        collapsedSize="0%"
        collapsible
        panelRef={(panel) => {
          panelRef.current = panel
        }}
      >
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
          {open ? (
            <DocumentViewer
              {...viewerProps}
              showActionLabels={false}
              focusActiveTab={focusActiveTab}
            />
          ) : null}
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function DocumentPreviewDialog({
  open,
  activeDocument,
  viewerProps,
}: {
  open: boolean
  activeDocument: AgentDocumentSource | null
  viewerProps: DocumentViewerProps
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) viewerProps.onCloseAll()
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[calc(100dvh-1rem)] max-h-none w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 sm:h-[min(88vh,56rem)] sm:w-[min(92vw,72rem)] sm:max-w-[min(92vw,72rem)]"
      >
        <DialogTitle className="sr-only">
          {activeDocument ? `Preview ${documentName(activeDocument)}` : "Document preview"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          Preview, switch between, and download documents from this conversation.
        </DialogDescription>
        {activeDocument ? (
          <DocumentViewer {...viewerProps} showActionLabels focusActiveTab={false} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function DocumentViewer({
  idPrefix,
  state,
  onSelect,
  onClose,
  onCloseAll,
  showActionLabels,
  focusActiveTab,
}: DocumentViewerProps & {
  readonly showActionLabels: boolean
  readonly focusActiveTab: boolean
}) {
  const activeDocument = state.documents.find((document) => document.id === state.activeId) ?? null
  const panelId = `${idPrefix}-document-panel`

  return (
    <>
      <DocumentTabs
        idPrefix={idPrefix}
        panelId={panelId}
        documents={state.documents}
        activeId={state.activeId}
        onSelect={onSelect}
        onClose={onClose}
        onCloseAll={onCloseAll}
        showActionLabels={showActionLabels}
        focusActiveTab={focusActiveTab}
      />
      {activeDocument ? (
        <div
          id={panelId}
          role="tabpanel"
          aria-labelledby={documentTabDomId(idPrefix, activeDocument.id)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <DocumentContent document={activeDocument} />
        </div>
      ) : null}
    </>
  )
}

function DocumentTabs({
  idPrefix,
  panelId,
  documents,
  activeId,
  onSelect,
  onClose,
  onCloseAll,
  showActionLabels,
  focusActiveTab,
}: {
  idPrefix: string
  panelId: string
  documents: readonly AgentDocumentSource[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onCloseAll: () => void
  showActionLabels: boolean
  focusActiveTab: boolean
}) {
  const activeDocument = documents.find((document) => document.id === activeId)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  useEffect(() => {
    if (!activeId) return
    const activeTab = tabRefs.current.get(activeId)
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" })
    if (focusActiveTab) activeTab?.focus()
  }, [activeId, focusActiveTab])

  const focusTab = (id: string) => {
    onSelect(id)
    tabRefs.current.get(id)?.focus()
  }
  const closeTab = (id: string) => {
    const closedIndex = documents.findIndex((document) => document.id === id)
    const focusId =
      id === activeId
        ? (documents[closedIndex + 1]?.id ?? documents[closedIndex - 1]?.id)
        : activeId
    onClose(id)
    if (focusId) queueMicrotask(() => tabRefs.current.get(focusId)?.focus())
  }
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      closeTab(id)
      return
    }
    if (!isDocumentTabNavigationKey(event.key)) return

    event.preventDefault()
    const nextId = documentTabIdAfterKey(
      documents.map((document) => document.id),
      id,
      event.key
    )
    if (nextId) focusTab(nextId)
  }

  return (
    <header className="flex h-11 shrink-0 items-center border-b border-border bg-muted/20">
      <div
        role="tablist"
        aria-label="Open documents"
        className="scrollbar-thin flex h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        {documents.map((document) => {
          const active = document.id === activeId
          const name = documentName(document)
          return (
            <div
              key={document.id}
              className={cn(
                "group/document-tab relative flex h-full max-w-64 shrink-0 items-center border-r border-border/60 transition-colors",
                active
                  ? "bg-background after:absolute after:inset-x-0 after:-bottom-px after:z-10 after:h-px after:bg-background"
                  : "hover:bg-muted/60"
              )}
            >
              <button
                ref={(element) => {
                  if (element) tabRefs.current.set(document.id, element)
                  else tabRefs.current.delete(document.id)
                }}
                id={documentTabDomId(idPrefix, document.id)}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={panelId}
                aria-keyshortcuts="Delete Backspace"
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(document.id)}
                onKeyDown={(event) => handleTabKeyDown(event, document.id)}
                className={cn(
                  "h-full min-w-0 flex-1 truncate px-3 text-left text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
                title={name}
              >
                {name}
              </button>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => closeTab(document.id)}
                className={cn(
                  "mr-2 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-40 transition-[color,background-color,opacity] hover:bg-muted hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  !active && "group-hover/document-tab:opacity-70"
                )}
                aria-label={`Close ${name}`}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex h-full shrink-0 items-center gap-0.5 border-l border-border/60 px-1.5">
        {activeDocument?.kind === "pdf" ? (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={activeDocument.inlineUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${documentName(activeDocument)} in a new tab`}
            >
              <ExternalLink />
              {showActionLabels ? <span className="hidden sm:inline">Open</span> : null}
            </a>
          </Button>
        ) : null}
        {activeDocument ? (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={activeDocument.downloadUrl}
              download={documentName(activeDocument)}
              aria-label={`Download ${documentName(activeDocument)}`}
            >
              <Download />
              {showActionLabels ? <span className="hidden sm:inline">Download</span> : null}
            </a>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onCloseAll}
          aria-label="Close document viewer"
        >
          <X />
        </Button>
      </div>
    </header>
  )
}

function DocumentContent({ document }: { document: AgentDocumentSource }) {
  const renderer = agentDocumentPreviewRenderer(document.kind)
  if (renderer === "markdown") return <MarkdownDocument document={document} />
  if (renderer === "html-static") return <HtmlDocument document={document} />
  if (renderer === "delimited-text") return <DelimitedTextDocument document={document} />
  if (renderer === "pdf-native") return <PdfDocument document={document} />

  return (
    <DocumentNotice
      title="Preview unavailable"
      description="This file type is not available in the document viewer yet."
    />
  )
}

function HtmlDocument({ document }: { document: AgentDocumentSource }) {
  const preview = useHtmlDocument(document)
  const safeDocument = useMemo(
    () => (preview.text === undefined ? null : buildSafeHtmlPreviewDocument(preview.text)),
    [preview.text]
  )

  if (preview.tooLarge) {
    return (
      <DocumentNotice
        title="Document is too large to preview"
        description="Download the file to view the complete document."
      />
    )
  }
  if (preview.loading) return <DocumentLoading />
  if (preview.error || safeDocument === null) {
    return (
      <DocumentNotice
        title="Could not preview document"
        description={preview.error ?? "The document did not contain readable HTML."}
      />
    )
  }

  const name = documentName(document)
  return (
    <iframe
      srcDoc={safeDocument}
      sandbox={HTML_PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      title={name}
      aria-label={`Preview ${name}`}
      className="min-h-0 w-full flex-1 border-0 bg-white"
    />
  )
}

function DelimitedTextDocument({ document }: { document: AgentDocumentSource }) {
  const preview = useDelimitedTextDocument(document)
  const parsed = useMemo(
    () => parseDelimitedPreview(preview.text, document.kind),
    [preview.text, document.kind]
  )

  if (preview.tooLarge) {
    return (
      <DocumentNotice
        title="Document is too large to preview"
        description="Download the file to view the complete document."
      />
    )
  }
  if (preview.loading) return <DocumentLoading />
  if (preview.error || parsed.error) {
    return (
      <DocumentNotice
        title="Could not preview table"
        description={preview.error ?? parsed.error ?? "The file could not be parsed."}
      />
    )
  }
  if (!parsed.data) {
    return (
      <DocumentNotice
        title="Could not preview table"
        description="The file did not contain readable rows."
      />
    )
  }

  const data = parsed.data
  const limited = data.rowsTruncated || data.columnsTruncated
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      {limited ? (
        <p
          className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
          role="status"
        >
          {delimitedLimitMessage(data)} Download the file to view all data.
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="w-max min-w-full border-separate border-spacing-0 text-sm"
          aria-label={`${documentName(document)} data preview`}
        >
          <thead>
            <tr>
              {data.headers.map((header, index) => (
                <th
                  key={index}
                  scope="col"
                  className="sticky top-0 z-10 max-w-96 min-w-32 border-r border-b border-border bg-muted/95 px-3 py-2.5 text-left text-[11px] font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase backdrop-blur last:border-r-0"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.length > 0 ? (
              data.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-muted/40">
                  {row.map((cell, columnIndex) => (
                    <td
                      key={columnIndex}
                      className="max-w-96 min-w-32 border-r border-b border-border/70 px-3 py-2 align-top text-foreground whitespace-pre-wrap break-words last:border-r-0"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={Math.max(data.headers.length, 1)}
                  className="px-4 py-12 text-center text-sm text-muted-foreground"
                >
                  No data rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function parseDelimitedPreview(
  text: string | undefined,
  kind: AgentDocumentSource["kind"]
): { readonly data: DelimitedTextPreview | null; readonly error: string | null } {
  if (text === undefined) return { data: null, error: null }
  if (kind !== "csv" && kind !== "tsv") {
    return { data: null, error: "The file is not CSV or TSV data." }
  }

  try {
    return { data: parseDelimitedText(text, kind), error: null }
  } catch (error) {
    return {
      data: null,
      error:
        error instanceof DelimitedTextParseError
          ? error.message
          : "The file contains malformed delimited text.",
    }
  }
}

function delimitedLimitMessage(data: DelimitedTextPreview): string {
  const limits: string[] = []
  if (data.rowsTruncated) {
    limits.push(
      `the first ${data.rows.length.toLocaleString()} of ${data.totalRows.toLocaleString()} rows`
    )
  }
  if (data.columnsTruncated) {
    limits.push(
      `the first ${data.headers.length.toLocaleString()} of ${data.totalColumns.toLocaleString()} columns`
    )
  }
  return `Showing ${limits.join(" and ")}.`
}

function PdfDocument({ document }: { document: AgentDocumentSource }) {
  const name = documentName(document)
  return (
    <object
      data={document.inlineUrl}
      type="application/pdf"
      title={name}
      aria-label={`Preview ${name}`}
      className="flex min-h-0 w-full flex-1 bg-muted/20"
    >
      <DocumentNotice
        title="PDF preview unavailable"
        description="Open the PDF in your browser or download it to view the document."
        action={
          <div className="flex justify-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={document.inlineUrl} target="_blank" rel="noreferrer">
                <ExternalLink />
                Open PDF
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={document.downloadUrl} download={name}>
                <Download />
                Download
              </a>
            </Button>
          </div>
        }
      />
    </object>
  )
}

function MarkdownDocument({ document }: { document: AgentDocumentSource }) {
  const preview = useMarkdownDocument(document)

  if (preview.tooLarge) {
    return (
      <DocumentNotice
        title="Document is too large to preview"
        description="Download the file to view the complete document."
      />
    )
  }
  if (preview.loading) return <DocumentLoading />
  if (preview.error || preview.text === undefined) {
    return (
      <DocumentNotice
        title="Could not preview document"
        description={preview.error ?? "The document did not contain readable text."}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20">
      <Markdown className="mx-auto min-h-full max-w-4xl bg-background px-6 py-8 sm:px-10 sm:py-12">
        {preview.text}
      </Markdown>
    </div>
  )
}

function DocumentLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center" aria-busy="true" role="status">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Loading document…
      </div>
    </div>
  )
}

function DocumentNotice({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-sm space-y-2">
        <FileWarning className="mx-auto size-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{description}</p>
        {action ? <div className="pt-2">{action}</div> : null}
      </div>
    </div>
  )
}

function isDocumentTabNavigationKey(value: string): value is DocumentTabNavigationKey {
  return value === "ArrowLeft" || value === "ArrowRight" || value === "Home" || value === "End"
}

function documentTabDomId(idPrefix: string, documentId: string): string {
  return `${idPrefix}-document-tab-${documentId}`
}

function documentName(document: AgentDocumentSource): string {
  return document.fileRef.fileName?.trim() || "Document"
}
