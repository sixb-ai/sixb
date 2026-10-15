import { Toaster, toast } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { ChevronLeft } from "lucide-react"
import type { ReactNode } from "react"
import { Link, Navigate, useLocation } from "react-router-dom"
import type { AppSectionId } from "../sections/catalog"
import {
  sectionContains,
  useOpenSections,
  useSectionNavMounted,
  useSections,
} from "../sections/sections"

// Section pages draw their own toasts so they never double up with a toaster of the project's.
const SECTION_TOASTER = "sixb-sections"

/** Toasts shown by built-in section pages. */
export const notify = {
  success: (message: string) => toast.success(message, { toasterId: SECTION_TOASTER }),
  error: (message: string) => toast.error(message, { toasterId: SECTION_TOASTER }),
}

export interface SectionPageProps {
  readonly section: AppSectionId
  /** The page's id in the section catalog; a detail page uses its list page's. */
  readonly page: string
  readonly title: string
  readonly description?: string
  /** Buttons beside the title, such as "New token". */
  readonly actions?: ReactNode
  /** On a detail page, the list it belongs to. */
  readonly back?: { readonly href: string; readonly label: string }
  /** A mark before the title, such as a connector's logo. */
  readonly icon?: ReactNode
  /** Facts under the title, such as a status pill. */
  readonly meta?: ReactNode
  readonly children: ReactNode
}

/**
 * The frame of every built-in section page: its title and description, its section's pages as
 * tabs when the shell has no `SectionNav`, and a redirect home for a page this person may not see.
 */
export function SectionPage({
  section,
  page,
  title,
  description,
  actions,
  back,
  icon,
  meta,
  children,
}: SectionPageProps) {
  const allowed = usePageAllowed(section, page)
  const showTabs = !useSectionNavMounted()

  if (!allowed) return <Navigate to="/" replace />

  return (
    <div className="mx-auto flex w-full max-w-[50rem] flex-col gap-8 px-5 pt-8 pb-20 md:px-10 md:pt-14">
      {showTabs ? <SectionTabs section={section} /> : null}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {back ? (
            <Link
              to={back.href}
              className="-ml-1 mb-3 flex w-fit items-center gap-0.5 rounded-md px-1 py-0.5 text-[0.8125rem] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
              {back.label}
            </Link>
          ) : null}
          <div className="flex min-w-0 items-center gap-3.5">
            {icon ? <div className="shrink-0">{icon}</div> : null}
            <div className="min-w-0">
              <h1 className="truncate text-[1.625rem] leading-8 font-semibold tracking-[-0.025em]">
                {title}
              </h1>
              {meta ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.8125rem] text-muted-foreground">
                  {meta}
                </div>
              ) : null}
            </div>
          </div>
          {description ? (
            <p className="mt-2 max-w-[60ch] text-sm leading-6 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2 sm:pt-0.5">{actions}</div> : null}
      </header>
      {children}
      <Toaster id={SECTION_TOASTER} />
    </div>
  )
}

export interface SectionWorkspaceProps {
  readonly section: AppSectionId
  /** The page's id in the section catalog; a detail page uses its list page's. */
  readonly page: string
  /** Usually a `WorkspaceHeader`, then content that grows to fill the frame. */
  readonly children: ReactNode
}

/**
 * A section page that fills the frame edge to edge, for a data grid or a canvas: no page margins
 * and a compact header, so the content gets the room. In a shell that gives the page no height it
 * takes nearly the window's.
 */
export function SectionWorkspace({ section, page, children }: SectionWorkspaceProps) {
  const allowed = usePageAllowed(section, page)
  const showTabs = !useSectionNavMounted()

  if (!allowed) return <Navigate to="/" replace />

  return (
    <div className="flex h-full min-h-[calc(100dvh-7rem)] w-full min-w-0 flex-col overflow-hidden">
      {showTabs ? (
        <div className="shrink-0 px-4 pt-2">
          <SectionTabs section={section} />
        </div>
      ) : null}
      {children}
      <Toaster id={SECTION_TOASTER} />
    </div>
  )
}

export interface WorkspaceHeaderProps {
  readonly back: { readonly href: string; readonly label: string }
  readonly icon?: ReactNode
  readonly title: ReactNode
  /** One line of facts under the title. */
  readonly meta?: ReactNode
  readonly actions?: ReactNode
}

/** The one-row header of a `SectionWorkspace`. */
export function WorkspaceHeader({ back, icon, title, meta, actions }: WorkspaceHeaderProps) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 md:px-4">
      <Link
        to={back.href}
        aria-label={back.label}
        title={back.label}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
      </Link>
      {icon ? <div className="shrink-0">{icon}</div> : null}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[0.9375rem] leading-5 font-semibold tracking-[-0.01em]">
          {title}
        </h1>
        {meta ? (
          <div className="flex min-w-0 items-center gap-x-2 overflow-hidden text-xs whitespace-nowrap text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  )
}

function usePageAllowed(section: AppSectionId, page: string): boolean {
  return useOpenSections().some(
    (candidate) =>
      candidate.definition.id === section && candidate.pages.some((entry) => entry.id === page)
  )
}

/** The redirect `/settings` and similar section roots answer with: the first page this person may open. */
export function SectionIndex({ section }: { readonly section: AppSectionId }) {
  const target = useOpenSections().find((candidate) => candidate.definition.id === section)
  return <Navigate to={target?.pages[0]?.path ?? "/"} replace />
}

function SectionTabs({ section }: { readonly section: AppSectionId }) {
  const { pathname } = useLocation()
  const current = useSections().find((candidate) => candidate.id === section)
  if (!current) return null
  const pages = current.pages.flatMap((entry) => ("group" in entry ? entry.items : [entry]))

  return (
    <nav aria-label={current.label} className="-mb-2 overflow-x-auto border-b border-border">
      <div className="flex min-w-max gap-6">
        {pages.map((page) => {
          const active = sectionContains({ ...current, pages: [page] }, pathname)
          return (
            <Link
              key={page.href}
              to={page.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px flex h-10 items-center border-b-2 text-sm font-medium transition-colors",
                active
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {page.label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
