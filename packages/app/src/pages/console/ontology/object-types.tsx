import type { ListObjectTypesResponse } from "@sixb/client"
import { listObjectTypesOptions } from "@sixb/client/hooks"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { CornerDownRight, LayoutGrid, Link2, Rows3, Zap } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { objectTypeHref } from "../../routes"
import { SectionPage } from "../../section-page"
import { apiErrorMessage, PanelEmpty, PanelSkeleton } from "../../section-ui"
import { CollectionToolbar } from "./components/collection-toolbar"
import { LetterAvatar } from "./components/common"
import { humanizeIdentifier } from "./lib/labels"

export { ConsoleObjectTypePage } from "./object-type"

type ObjectTypeSummary = ListObjectTypesResponse[number]
type PropertySummary = ObjectTypeSummary["properties"][number]

const PROPERTY_PREVIEW_LIMIT = 4
const noObjectTypes: ObjectTypeSummary[] = []

/** Console › Object types: every type, searchable by its fields, links and actions. */
export function ConsoleObjectTypesPage() {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")
  const typesQuery = useQuery({ ...listObjectTypesOptions(), retry: false })
  const objectTypes = typesQuery.data ?? noObjectTypes
  const byId = useMemo(() => new Map(objectTypes.map((type) => [type.id, type])), [objectTypes])
  const filtered = useMemo(() => {
    const sorted = [...objectTypes].sort((a, b) => displayName(a).localeCompare(displayName(b)))
    const query = search.trim().toLowerCase()
    return query ? sorted.filter((type) => matchesType(type, query)) : sorted
  }, [objectTypes, search])

  return (
    <SectionPage
      section="console"
      page="object-types"
      width="wide"
      title="Object types"
      meta={<span>{countLabel(objectTypes.length, "type")}</span>}
    >
      <div className="-mt-4 flex flex-col">
        <CollectionToolbar
          search={{
            value: search,
            placeholder: "Search types, fields, or links...",
            onChange: setSearch,
          }}
        />
        {typesQuery.isPending ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <PanelSkeleton rows={4} />
          </div>
        ) : typesQuery.isError ? (
          <PanelEmpty
            tone="error"
            icon={LayoutGrid}
            title="Could not load the object types"
            description={apiErrorMessage(typesQuery.error, "Try again in a moment.")}
          />
        ) : objectTypes.length === 0 ? (
          <PanelEmpty icon={LayoutGrid} title="No object types defined." />
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No types matching "{search}".
          </div>
        ) : (
          <div className="mt-2 overflow-hidden rounded-xl border border-border bg-card shadow-[0_1px_2px_0_rgb(0_0_0/0.04)]">
            <ul className="divide-y divide-border">
              {filtered.map((type) => (
                <li key={type.id}>
                  <TypeRow
                    type={type}
                    parent={type.extends ? (byId.get(type.extends) ?? null) : null}
                    onSelect={() => navigate(objectTypeHref(type.id))}
                    onSelectType={(typeId) => navigate(objectTypeHref(typeId))}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SectionPage>
  )
}

function countLabel(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`
}

interface TypeRowProps {
  type: ObjectTypeSummary
  parent: ObjectTypeSummary | null
  onSelect: () => void
  onSelectType: (typeId: string) => void
}

function TypeRow({ type, parent, onSelect, onSelectType }: TypeRowProps) {
  const preview = previewProperties(type.properties, PROPERTY_PREVIEW_LIMIT)
  const remaining = type.properties.length - preview.length
  const name = displayName(type)
  const showId = !isRedundantId(name, type.id)

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className="group flex cursor-pointer items-start gap-4 px-4 py-3.5 transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
    >
      <div className="pt-0.5">
        <LetterAvatar label={name} size="sm" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-foreground">{name}</span>
          {showId ? (
            <code className="font-mono text-[11px] text-muted-foreground">{type.id}</code>
          ) : null}
          {parent ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                onSelectType(parent.id)
              }}
              className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <CornerDownRight className="size-2.5" />
              extends {displayName(parent)}
            </button>
          ) : null}
        </div>
        {type.description ? (
          <p className="line-clamp-1 text-xs leading-5 text-foreground/75">{type.description}</p>
        ) : null}
        {preview.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11px]">
            {preview.map((property, index) => (
              <span key={property.id} className="flex items-center gap-1.5">
                <span
                  className={cn(property.primary ? "text-foreground" : "text-muted-foreground")}
                >
                  {property.id}
                </span>
                {index < preview.length - 1 ? (
                  <span aria-hidden="true" className="text-border">
                    ·
                  </span>
                ) : null}
              </span>
            ))}
            {remaining > 0 ? (
              <span className="ml-0.5 text-muted-foreground/70">+{remaining}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="hidden shrink-0 items-center gap-4 pt-1 text-[11px] tabular-nums text-muted-foreground sm:flex">
        <Metric
          icon={<Rows3 className="size-3.5" />}
          value={type.properties.length}
          label="properties"
        />
        {type.links.length > 0 ? (
          <Metric icon={<Link2 className="size-3.5" />} value={type.links.length} label="links" />
        ) : null}
        {type.actions.length > 0 ? (
          <Metric icon={<Zap className="size-3.5" />} value={type.actions.length} label="actions" />
        ) : null}
      </div>
    </div>
  )
}

function Metric({ icon, value, label }: { icon: React.ReactNode; value: number; label: string }) {
  return (
    <span className="flex items-center gap-1.5" title={`${value} ${label}`}>
      <span className="text-muted-foreground/70">{icon}</span>
      <span>{value}</span>
    </span>
  )
}

function previewProperties(properties: PropertySummary[], limit: number): PropertySummary[] {
  const primary = properties.find((property) => property.primary)
  const rest = properties.filter((property) => property.id !== primary?.id)
  return (primary ? [primary, ...rest] : rest).slice(0, limit)
}

function displayName(type: ObjectTypeSummary): string {
  return humanizeIdentifier(type.name || type.id)
}

function isRedundantId(name: string, id: string): boolean {
  return normalize(name) === normalize(id)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_.-]+/g, "")
}

export function matchesType(type: ObjectTypeSummary, query: string): boolean {
  if (
    type.id.toLowerCase().includes(query) ||
    type.name.toLowerCase().includes(query) ||
    (type.description?.toLowerCase().includes(query) ?? false)
  ) {
    return true
  }
  return (
    type.properties.some(
      (property) =>
        property.id.toLowerCase().includes(query) || property.name.toLowerCase().includes(query)
    ) ||
    type.links.some((link) =>
      [
        link.id,
        link.name,
        ...(Array.isArray(link.targetObjectTypeId) ? link.targetObjectTypeId : []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query)
    ) ||
    type.actions.some(
      (action) =>
        action.id.toLowerCase().includes(query) || action.name.toLowerCase().includes(query)
    )
  )
}
