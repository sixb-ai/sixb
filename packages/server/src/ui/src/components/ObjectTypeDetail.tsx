import { getObjectTypeOptions, listProjectionsOptions } from "@pario/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { humanizeIdentifier } from "../lib/labels"
import { cn } from "../lib/utils"
import { GlassCard, LoadingSpinner } from "./common"
import { Badge } from "./ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs"

export function ObjectTypeDetail() {
  const { typeId } = useParams<{ typeId: string }>()
  const navigate = useNavigate()

  const { data: objectType, isLoading } = useQuery(
    getObjectTypeOptions({ path: { objectTypeId: typeId! } })
  )

  const { data: projections } = useQuery(listProjectionsOptions())

  const typeProjections = useMemo(() => {
    if (!projections || !typeId) return { object: [], link: [] }
    return {
      object: projections.objectProjections.filter((p) => p.objectTypeId === typeId),
      link: projections.linkProjections.filter(
        (p) => p.sourceObjectTypeId === typeId || p.targetObjectTypeId === typeId
      ),
    }
  }, [projections, typeId])

  const hasProjections = typeProjections.object.length > 0 || typeProjections.link.length > 0

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner text="Loading type..." />
      </div>
    )
  }

  if (!objectType) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        Type "{typeId}" not found.
      </div>
    )
  }

  const staticProps = objectType.properties.filter((p) => p.mode !== "telemetry")
  const telemetryProps = objectType.properties.filter((p) => p.mode === "telemetry")

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate("/ontology")}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M15 19l-7-7 7-7"
            />
          </svg>
          Ontology
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-foreground">
            {humanizeIdentifier(objectType.name || objectType.id)}
          </h1>
          <Badge variant="outline" className="text-[10px] font-mono">
            {objectType.id}
          </Badge>
          {objectType.extends && (
            <button
              onClick={() => navigate(`/ontology/${objectType.extends}`)}
              className="transition-colors"
            >
              <Badge
                variant="outline"
                className="text-[10px] hover:border-primary/50 cursor-pointer"
              >
                extends {objectType.extends}
              </Badge>
            </button>
          )}
        </div>
        {objectType.description && (
          <p className="text-sm text-muted-foreground">{objectType.description}</p>
        )}
      </div>

      {/* Tabs */}
      <Tabs defaultValue="properties">
        <TabsList>
          <TabsTrigger value="properties">Properties ({objectType.properties.length})</TabsTrigger>
          <TabsTrigger value="links">Links ({objectType.links.length})</TabsTrigger>
          <TabsTrigger value="actions">Actions ({objectType.actions.length})</TabsTrigger>
          {hasProjections && (
            <TabsTrigger value="projections">
              Projections ({typeProjections.object.length + typeProjections.link.length})
            </TabsTrigger>
          )}
        </TabsList>

        {/* Properties Tab */}
        <TabsContent value="properties" className="space-y-4">
          {staticProps.length > 0 && (
            <PropertiesTable title="Static Properties" properties={staticProps} />
          )}
          {telemetryProps.length > 0 && (
            <PropertiesTable title="Telemetry Properties" properties={telemetryProps} />
          )}
          {objectType.properties.length === 0 && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No properties defined.
            </div>
          )}
        </TabsContent>

        {/* Links Tab */}
        <TabsContent value="links" className="space-y-3">
          {objectType.links.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">No links defined.</div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {objectType.links.map((link) => {
                const targets = Array.isArray(link.targetObjectTypeId)
                  ? link.targetObjectTypeId
                  : [link.targetObjectTypeId]

                return (
                  <GlassCard key={link.id} padding="sm">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <svg
                          className="h-3.5 w-3.5 text-muted-foreground shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"
                          />
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={1.5}
                            d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 10-5.656-5.656l-1.102 1.101"
                          />
                        </svg>
                        <span className="text-sm font-medium text-foreground">
                          {humanizeIdentifier(link.name || link.id)}
                        </span>
                        {link.cardinality && (
                          <Badge variant="outline" className="text-[10px]">
                            {link.cardinality}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs text-muted-foreground">→</span>
                        {targets.map((targetId) => (
                          <button
                            key={targetId}
                            onClick={() => {
                              if (targetId !== "*") navigate(`/ontology/${targetId}`)
                            }}
                            className={cn(
                              "text-xs",
                              targetId === "*"
                                ? "text-muted-foreground italic"
                                : "text-primary hover:underline cursor-pointer"
                            )}
                          >
                            {targetId === "*" ? "any type" : targetId}
                          </button>
                        ))}
                      </div>
                    </div>
                  </GlassCard>
                )
              })}
            </div>
          )}
        </TabsContent>

        {/* Actions Tab */}
        <TabsContent value="actions" className="space-y-3">
          {objectType.actions.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No actions defined.
            </div>
          ) : (
            <div className="space-y-2">
              {objectType.actions.map((action) => (
                <GlassCard key={action.id} padding="sm">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {humanizeIdentifier(action.name || action.id)}
                      </span>
                      {action.params.length > 0 && (
                        <Badge variant="outline" className="text-[10px]">
                          {action.params.length} params
                        </Badge>
                      )}
                    </div>
                    {action.description && (
                      <p className="text-xs text-muted-foreground">{action.description}</p>
                    )}
                    {action.params.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {action.params.map((param) => (
                          <span
                            key={param.id}
                            className="text-[10px] rounded bg-accent/60 px-1.5 py-0.5 text-muted-foreground font-mono"
                          >
                            {param.id}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </GlassCard>
              ))}
            </div>
          )}
        </TabsContent>

        {/* Projections Tab */}
        {hasProjections && (
          <TabsContent value="projections" className="space-y-4">
            {typeProjections.object.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Object Projections
                </h3>
                {typeProjections.object.map((proj) => (
                  <GlassCard key={proj.id} padding="sm">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{proj.id}</span>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {proj.datasetId}
                        </Badge>
                      </div>
                      <div className="space-y-1">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Property Mappings
                        </p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                          {Object.entries(proj.properties).map(([propId, column]) => (
                            <div key={propId} className="flex items-center gap-1 text-xs">
                              <span className="text-foreground font-mono">{propId}</span>
                              <span className="text-muted-foreground">←</span>
                              <span className="text-muted-foreground font-mono">{column}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {Object.keys(proj.links).length > 0 && (
                        <div className="space-y-1">
                          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                            FK Links
                          </p>
                          {Object.entries(proj.links).map(([linkId, fk]) => (
                            <div key={linkId} className="flex items-center gap-1 text-xs">
                              <span className="text-foreground font-mono">{linkId}</span>
                              <span className="text-muted-foreground">via</span>
                              <span className="text-muted-foreground font-mono">
                                {fk.sourcePropertyId}
                              </span>
                              <span className="text-muted-foreground">→</span>
                              <button
                                onClick={() => navigate(`/ontology/${fk.targetObjectTypeId}`)}
                                className="text-primary hover:underline font-mono"
                              >
                                {fk.targetObjectTypeId}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </GlassCard>
                ))}
              </div>
            )}

            {typeProjections.link.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Link Projections
                </h3>
                {typeProjections.link.map((proj) => (
                  <GlassCard key={proj.id} padding="sm">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{proj.id}</span>
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {proj.datasetId}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1 text-xs">
                        <span className="text-muted-foreground">Link:</span>
                        <span className="text-foreground font-mono">{proj.linkId}</span>
                      </div>
                      <div className="flex items-center gap-1 text-xs">
                        <button
                          onClick={() => navigate(`/ontology/${proj.sourceObjectTypeId}`)}
                          className="text-primary hover:underline font-mono"
                        >
                          {proj.sourceObjectTypeId}
                        </button>
                        <span className="text-muted-foreground font-mono">.{proj.sourceField}</span>
                        <span className="text-muted-foreground">→</span>
                        <button
                          onClick={() => navigate(`/ontology/${proj.targetObjectTypeId}`)}
                          className="text-primary hover:underline font-mono"
                        >
                          {proj.targetObjectTypeId}
                        </button>
                        <span className="text-muted-foreground font-mono">.{proj.targetField}</span>
                      </div>
                    </div>
                  </GlassCard>
                ))}
              </div>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}

function PropertiesTable({
  title,
  properties,
}: {
  title: string
  properties: {
    id: string
    name: string
    description?: string
    mode?: string
    required?: boolean
    nullable?: boolean
    primary?: boolean
    schema?: unknown
  }[]
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {title}
      </h3>
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/50 bg-accent/30">
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Schema</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Flags</th>
            </tr>
          </thead>
          <tbody>
            {properties.map((prop) => (
              <tr key={prop.id} className="border-b border-border/30 last:border-b-0">
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-foreground">{prop.id}</span>
                    {prop.primary && (
                      <Badge className="bg-primary/15 text-primary text-[9px] px-1 py-0">
                        primary
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-muted-foreground font-mono">
                  {formatSchema(prop.schema)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    {prop.required && (
                      <span className="text-[10px] rounded bg-accent/60 px-1 py-0.5 text-muted-foreground">
                        required
                      </span>
                    )}
                    {prop.nullable && (
                      <span className="text-[10px] rounded bg-accent/60 px-1 py-0.5 text-muted-foreground">
                        nullable
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function formatSchema(schema: unknown): string {
  if (typeof schema === "string") return schema
  if (typeof schema === "object" && schema !== null && "type" in schema) {
    return String((schema as { type: unknown }).type)
  }
  return "unknown"
}
