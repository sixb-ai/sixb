import type { ListObjectTypesResponse } from "@sixb/client"
import { listObjectTypesOptions } from "@sixb/client/hooks"
import { CollectionHeader, Input } from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { CornerDownRight, Link2, Rows3, Search, Zap } from "lucide-react"
import { useMemo, useState } from "react"
import { LetterAvatar } from "../components/common"
import { humanizeIdentifier } from "../lib/labels"

type ObjectTypeSummary = ListObjectTypesResponse[number]
type PropertySummary = ObjectTypeSummary["properties"][number]

interface OntologyExplorerProps {
  onSelectType: (typeId: string) => void
}

const PROPERTY_PREVIEW_LIMIT = 4

export function OntologyExplorer({ onSelectType }: OntologyExplorerProps) {
  const [search, setSearch] = useState("")

  const { data: objectTypes = [] } = useQuery(listObjectTypesOptions())

  const byId = useMemo(() => {
    const map = new Map<string, ObjectTypeSummary>()
    for (const t of objectTypes) map.set(t.id, t)
    return map
  }, [objectTypes])

  const sorted = useMemo(
    () => [...objectTypes].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [objectTypes]
  )

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return sorted
    return sorted.filter((t) => matchesType(t, query))
  }, [sorted, search])

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <CollectionHeader
        title="Ontology"
        count={objectTypes.length}
        actions={
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search types..."
              className="pl-9"
            />
          </div>
        }
      />

      {/* List */}
      {objectTypes.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          No object types defined.
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          No types matching "{search}".
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <ul className="divide-y divide-border">
            {filtered.map((type) => (
              <li key={type.id}>
                <TypeRow
                  type={type}
                  parent={type.extends ? (byId.get(type.extends) ?? null) : null}
                  onSelect={() => onSelectType(type.id)}
                  onSelectType={onSelectType}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
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
        {/* Title line */}
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

        {/* Description — single line, slightly more present than property preview */}
        {type.description ? (
          <p className="line-clamp-1 text-xs leading-5 text-foreground/75">{type.description}</p>
        ) : null}

        {/* Property preview — primary first, rendered in foreground; rest muted */}
        {preview.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11px]">
            {preview.map((prop, index) => (
              <span key={prop.id} className="flex items-center gap-1.5">
                <span className={cn(prop.primary ? "text-foreground" : "text-muted-foreground")}>
                  {prop.id}
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

      {/* Counts — small icons + numbers, right-aligned baseline */}
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

function previewProperties(props: PropertySummary[], limit: number): PropertySummary[] {
  const primary = props.find((p) => p.primary)
  const rest = props.filter((p) => p.id !== primary?.id)
  const ordered = primary ? [primary, ...rest] : rest
  return ordered.slice(0, limit)
}

function displayName(t: ObjectTypeSummary): string {
  return humanizeIdentifier(t.name || t.id)
}

function isRedundantId(name: string, id: string): boolean {
  return normalize(name) === normalize(id)
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s_.-]+/g, "")
}

function matchesType(t: ObjectTypeSummary, query: string): boolean {
  if (
    t.id.toLowerCase().includes(query) ||
    t.name.toLowerCase().includes(query) ||
    (t.description?.toLowerCase().includes(query) ?? false)
  ) {
    return true
  }
  return t.properties.some(
    (p) => p.id.toLowerCase().includes(query) || p.name.toLowerCase().includes(query)
  )
}
