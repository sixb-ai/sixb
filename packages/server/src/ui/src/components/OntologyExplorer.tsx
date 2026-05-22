import { listObjectTypesOptions } from "@pario/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { humanizeIdentifier } from "../lib/labels"
import { cn } from "../lib/utils"
import { GlassCard, SearchInput } from "./common"
import { OntologyGraph } from "./OntologyGraph"
import { Badge } from "./ui/badge"

type ViewStyle = "cards" | "graph"

interface OntologyExplorerProps {
  onSelectType: (typeId: string) => void
}

export function OntologyExplorer({ onSelectType }: OntologyExplorerProps) {
  const [viewStyle, setViewStyle] = useState<ViewStyle>("cards")
  const [search, setSearch] = useState("")

  const { data: objectTypes = [] } = useQuery(listObjectTypesOptions())

  const filtered = useMemo(() => {
    if (!search.trim()) return objectTypes
    const query = search.toLowerCase()
    return objectTypes.filter(
      (t) => t.id.toLowerCase().includes(query) || t.name.toLowerCase().includes(query)
    )
  }, [objectTypes, search])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">Ontology</h1>
          <Badge variant="outline" className="text-xs">
            {objectTypes.length} types
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search types..."
            className="w-48"
          />
          <div className="flex rounded-lg border border-border/60 bg-card/60 p-0.5">
            {(["cards", "graph"] as const).map((style) => (
              <button
                key={style}
                onClick={() => setViewStyle(style)}
                className={cn(
                  "px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize",
                  viewStyle === style
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {style}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      {viewStyle === "cards" && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <button key={t.id} onClick={() => onSelectType(t.id)} className="text-left">
              <GlassCard className="group cursor-pointer transition-all hover:border-primary/30 hover:shadow-md">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {humanizeIdentifier(t.name || t.id)}
                    </h3>
                    {t.extends && (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        extends {t.extends}
                      </Badge>
                    )}
                  </div>

                  {t.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">{t.description}</p>
                  )}

                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{t.properties.length} properties</span>
                    <span className="text-border">·</span>
                    <span>{t.links.length} links</span>
                    <span className="text-border">·</span>
                    <span>{t.actions.length} actions</span>
                  </div>
                </div>
              </GlassCard>
            </button>
          ))}

          {filtered.length === 0 && search.trim() && (
            <div className="col-span-full py-8 text-center text-sm text-muted-foreground">
              No types matching "{search}"
            </div>
          )}
        </div>
      )}

      {viewStyle === "graph" && (
        <OntologyGraph objectTypes={objectTypes} onSelectType={onSelectType} />
      )}
    </div>
  )
}
