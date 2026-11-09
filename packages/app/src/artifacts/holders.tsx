import type { ListArtifactHoldersResponse } from "@sixb/client"
import { listArtifactHoldersOptions, listObjectTypesOptions } from "@sixb/client/hooks"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { Box, ChevronDown } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { humanizeIdentifier } from "../pages/console/ontology/lib/labels"
import { objectHref } from "../pages/routes"
import { useSharedGuest } from "../shared-session"
import { useArtifactMessages } from "./messages"

type Holder = ListArtifactHoldersResponse["holders"][number]

/** Who holds an artifact changes rarely, and only by an edit to an object. */
const HOLDERS_STALE_MS = 60_000

const PILL =
  "inline-flex h-6 max-w-[14rem] min-w-0 shrink items-center gap-1.5 rounded-full border border-border/80 bg-card pr-2 pl-1.5 text-xs font-medium text-muted-foreground shadow-[0_1px_1px_rgb(0_0_0/0.03)] outline-none transition-colors hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-border data-[state=open]:text-foreground"

/**
 * The objects an artifact belongs to, beside its title: the one that holds it, as a pill that opens
 * its page, or the first of several with the others a click away. A narrow header, as a phone's,
 * keeps the title's room: the pill is its icon, which lists them. Only those the reader can see
 * are listed; an artifact no object holds, for this reader, shows nothing.
 */
export function ArtifactHolders({ artifactId }: { readonly artifactId: string }) {
  const messages = useArtifactMessages().viewer
  const { data } = useQuery({
    ...listArtifactHoldersOptions({ path: { artifactId } }),
    staleTime: HOLDERS_STALE_MS,
    retry: false,
  })
  const label = useHolderLabel()
  const guest = useSharedGuest() !== null

  const holders = data?.holders ?? []
  const [first] = holders
  if (!first) return null

  const others = holders.length - 1 + (data?.hasMore ? 1 : 0)
  const named =
    others === 0
      ? `${messages.belongsTo} ${label(first)}`
      : messages.belongsToMany(holders.length, data?.hasMore ?? false)

  // A shared link's guest reads the objects their link shares, not the app's pages about them:
  // the pill says what holds the artifact, and goes nowhere.
  if (guest) {
    return (
      <span title={named} aria-label={named} className={cn(PILL, "hover:border-border/80")}>
        <ObjectIcon />
        <span className="hidden truncate @md:inline">{label(first)}</span>
        {others > 0 ? (
          <span className="hidden shrink-0 tabular-nums @md:inline">
            {messages.andMore(others)}
          </span>
        ) : null}
      </span>
    )
  }

  const wide =
    others === 0 ? (
      <Link
        to={objectHref(first.objectTypeId, first.primaryId)}
        title={named}
        aria-label={named}
        className={PILL}
      >
        <ObjectIcon />
        <span className="truncate">{label(first)}</span>
      </Link>
    ) : (
      <HolderMenu holders={holders} label={label} named={named} className={PILL}>
        <ObjectIcon />
        <span className="truncate">{label(first)}</span>
        <span className="shrink-0 tabular-nums">{messages.andMore(others)}</span>
        <ChevronDown className="size-3 shrink-0 opacity-70" aria-hidden="true" />
      </HolderMenu>
    )

  return (
    <>
      <span className="hidden min-w-0 @md:contents">{wide}</span>
      <span className="contents @md:hidden">
        <HolderMenu
          holders={holders}
          label={label}
          named={named}
          className={cn(PILL, "w-6 shrink-0 justify-center px-0")}
        >
          <ObjectIcon />
        </HolderMenu>
      </span>
    </>
  )
}

function ObjectIcon() {
  return (
    <Box className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
  )
}

/** The holders as a menu, each opening its object's page. */
function HolderMenu({
  holders,
  label,
  named,
  className,
  children,
}: {
  readonly holders: readonly Holder[]
  readonly label: (holder: Holder) => string
  /** What the trigger says to assistive technology, and on hover. */
  readonly named: string
  readonly className: string
  readonly children: ReactNode
}) {
  const messages = useArtifactMessages().viewer

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={named} title={named} className={className}>
        {children}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-1.5rem)]">
        <DropdownMenuLabel>{messages.belongsTo}</DropdownMenuLabel>
        {holders.map((holder) => (
          <DropdownMenuItem
            key={`${holder.objectTypeId}:${holder.primaryId}:${holder.propertyId}`}
            asChild
            className="gap-2.5"
          >
            <Link to={objectHref(holder.objectTypeId, holder.primaryId)}>
              <Box className="size-4 text-emerald-600 dark:text-emerald-400" />
              <span className="min-w-0 flex-1 truncate">{label(holder)}</span>
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * How a holder reads: the object's title and the property that holds the artifact, as
 * "NLM-23077 · Onboarding plan". An object whose type has no title reads as its type and key.
 */
function useHolderLabel(): (holder: Holder) => string {
  const types = useQuery({ ...listObjectTypesOptions(), staleTime: HOLDERS_STALE_MS, retry: false })

  return (holder) => {
    const type = types.data?.find((candidate) => candidate.id === holder.objectTypeId)
    const property = type?.properties.find((candidate) => candidate.id === holder.propertyId)
    const object =
      holder.title ?? `${type?.name ?? humanizeIdentifier(holder.objectTypeId)} ${holder.primaryId}`

    return [object, humanizeIdentifier(property?.name || holder.propertyId)].join(" · ")
  }
}
