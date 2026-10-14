import { Toaster, toast } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
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
  /** The page's id in the section catalog. */
  readonly page: string
  readonly title: string
  readonly description?: string
  /** Buttons beside the title, such as "New token". */
  readonly actions?: ReactNode
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
  children,
}: SectionPageProps) {
  const open = useOpenSections()
  const showTabs = !useSectionNavMounted()
  const allowed = open.some(
    (candidate) =>
      candidate.definition.id === section && candidate.pages.some((entry) => entry.id === page)
  )

  if (!allowed) return <Navigate to="/" replace />

  return (
    <div className="mx-auto flex w-full max-w-[50rem] flex-col gap-8 px-5 pt-8 pb-20 md:px-10 md:pt-14">
      {showTabs ? <SectionTabs section={section} /> : null}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-[1.625rem] leading-8 font-semibold tracking-[-0.025em]">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-[60ch] text-sm leading-6 text-muted-foreground">
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
