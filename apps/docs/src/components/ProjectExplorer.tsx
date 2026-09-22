"use client"

import { Sheet, SheetContent, SheetTitle } from "@sixb/ui/components"
import { Check, ChevronRight, Copy, FileCode2, Folder, FolderOpen, Info } from "lucide-react"
import { type CSSProperties, useId, useMemo, useRef, useState } from "react"
import { projects } from "../generated/projectFiles"
import { useClipboard } from "./useClipboard"

export function ProjectExplorer({ renderCode }: { renderCode: (html: string) => React.ReactNode }) {
  const sourceId = useId()
  const collection = projects.starter
  const [selected, setSelected] = useState<string>(collection.initialFile)
  const [filesOpen, setFilesOpen] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(180)
  const root = useRef<HTMLElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const file = collection.files.find((entry) => entry.path === selected) ?? collection.files[0]
  const code = useMemo(
    () => renderCode(file.html.replace(/<figcaption\b[\s\S]*?<\/figcaption>/g, "")),
    [file.html, renderCode]
  )
  const parts = file.path.split("/")
  const { status, copy } = useClipboard(file.code)
  const copied = status === "copied"

  function resize(width: number) {
    const max = Math.min(360, (root.current?.clientWidth ?? 700) * 0.45)
    setSidebarWidth(Math.max(160, Math.min(max, width)))
  }
  function renderFolder(parent: string): React.ReactNode {
    const entries = collection.files.filter((entry) => entry.path.startsWith(parent))
    const children = [
      ...new Set(entries.map((entry) => entry.path.slice(parent.length).split("/")[0]!)),
    ].sort((a, b) => {
      const folderA = entries.some((entry) => entry.path.startsWith(`${parent}${a}/`))
      const folderB = entries.some((entry) => entry.path.startsWith(`${parent}${b}/`))
      return Number(folderB) - Number(folderA) || a.localeCompare(b)
    })
    return children.map((name) => {
      const path = `${parent}${name}`
      if (!entries.some((entry) => entry.path === path))
        return (
          <details key={path} open={file.path.startsWith(`${path}/`)}>
            <summary>
              <ChevronRight size={12} aria-hidden="true" />
              <Folder size={14} aria-hidden="true" />
              <span>{name}</span>
            </summary>
            <div className="project-folder-children">{renderFolder(`${path}/`)}</div>
          </details>
        )
      return (
        <div key={path} className="project-file-entry">
          <button
            type="button"
            className="project-file"
            title={path}
            aria-label={path}
            aria-pressed={path === file.path}
            aria-controls={sourceId}
            onClick={() => {
              setSelected(path)
              setFilesOpen(false)
            }}
          >
            <FileCode2 size={14} aria-hidden="true" />
            <span>{name}</span>
          </button>
        </div>
      )
    })
  }
  return (
    <section
      ref={root}
      className="project-explorer"
      style={{ "--explorer-sidebar": `${sidebarWidth}px` } as CSSProperties}
      aria-label={`${collection.title} code explorer`}
    >
      <div className="project-explorer-title">
        <span className="project-name">
          <FolderOpen size={14} />
          {collection.title}
        </span>
        <div className="project-open-file">
          <span className="project-ts-badge">{file.path.endsWith("tsx") ? "TSX" : "TS"}</span>
          {parts.at(-1)}
        </div>
      </div>
      <div className="project-explorer-body">
        <nav className="project-files project-desktop-files" aria-label="Project files">
          {renderFolder("")}
        </nav>
        <div
          className="project-resizer"
          role="separator"
          aria-label="File sidebar width"
          aria-orientation="vertical"
          aria-valuemin={160}
          aria-valuemax={360}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={(event) => {
            drag.current = { x: event.clientX, width: sidebarWidth }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (drag.current) resize(drag.current.width + event.clientX - drag.current.x)
          }}
          onPointerUp={() => {
            drag.current = null
          }}
          onLostPointerCapture={() => {
            drag.current = null
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault()
              resize(sidebarWidth + (event.key === "ArrowLeft" ? -16 : 16))
            }
          }}
        />
        <div className="project-source" id={sourceId} role="region" aria-label={file.path}>
          <div className="project-source-title">
            <button
              className="project-mobile-files"
              type="button"
              onClick={() => setFilesOpen(true)}
            >
              <FolderOpen size={14} />
              Files
            </button>
            <div className="project-breadcrumb" title={file.path} aria-live="polite">
              {parts.map((part, index) => (
                <span key={parts.slice(0, index + 1).join("/")}>
                  {index > 0 && <ChevronRight size={11} />}
                  {part}
                </span>
              ))}
            </div>
            <details className="project-info" key={file.path}>
              <summary aria-label="About this file">
                <Info size={15} />
              </summary>
              <p>{file.description}</p>
            </details>
            <button
              className="project-copy"
              type="button"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy code"}
              title={copied ? "Copied" : "Copy code"}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
          <div className="project-code-scroll" key={file.path}>
            {code}
          </div>
        </div>
      </div>
      <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
        <SheetContent side="left" className="w-80 overflow-y-auto p-5">
          <SheetTitle className="mb-5 text-sm">{collection.title}</SheetTitle>
          <nav className="project-files" aria-label="Project files">
            {renderFolder("")}
          </nav>
        </SheetContent>
      </Sheet>
    </section>
  )
}
