import {
  getObjectTypeOptions,
  listObjectTypesOptions,
  listProjectionsOptions,
} from "@sixb/client/hooks"
import {
  Badge,
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@sixb/ui/components"
import { cn } from "@sixb/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Network } from "lucide-react"
import { Fragment, type ReactNode, useMemo } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router-dom"
import { BackNav, LetterAvatar, LoadingState } from "../components/common"
import { humanizeIdentifier } from "../lib/labels"

const TAB_VALUES = ["properties", "links", "actions", "projections"] as const
type TabValue = (typeof TAB_VALUES)[number]
const DEFAULT_TAB: TabValue = "properties"

function isTabValue(value: string | null): value is TabValue {
  return value !== null && (TAB_VALUES as readonly string[]).includes(value)
}

interface ObjectTypeDetailProps {
  objectTypeId?: string
  embedded?: boolean
  onSelectType?: (typeId: string) => void
}

export function ObjectTypeDetail({
  objectTypeId,
  embedded = false,
  onSelectType,
}: ObjectTypeDetailProps = {}) {
  const { typeId: routeTypeId } = useParams<{ typeId: string }>()
  const typeId = objectTypeId ?? routeTypeId
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const selectType = (nextTypeId: string) => {
    if (onSelectType) {
      onSelectType(nextTypeId)
    } else {
      navigate(`/ontology/${nextTypeId}`)
    }
  }

  const tabParam = searchParams.get("tab")
  const activeTab: TabValue = isTabValue(tabParam) ? tabParam : DEFAULT_TAB

  const setActiveTab = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (next === DEFAULT_TAB) {
          params.delete("tab")
        } else {
          params.set("tab", next)
        }
        return params
      },
      { replace: true }
    )
  }

  const { data: objectType, isLoading } = useQuery(
    getObjectTypeOptions({ path: { objectTypeId: typeId! } })
  )

  const { data: allTypes = [] } = useQuery(listObjectTypesOptions())
  const { data: projections } = useQuery(listProjectionsOptions())

  const { ancestors, subtypes } = useMemo(() => {
    if (!objectType) return { ancestors: [], subtypes: [] }
    const byId = new Map(allTypes.map((t) => [t.id, t]))
    const ancestors: typeof allTypes = []
    let cursor = objectType.extends
    while (cursor) {
      const parent = byId.get(cursor)
      if (!parent) break
      ancestors.unshift(parent)
      cursor = parent.extends
    }
    const subtypes = allTypes.filter((t) => t.extends === objectType.id)
    return { ancestors, subtypes }
  }, [objectType, allTypes])

  const typeProjections = useMemo(() => {
    if (!projections || !typeId) return { object: [], link: [], telemetry: [] }
    return {
      object: projections.objectProjections.filter((p) => p.objectTypeId === typeId),
      link: projections.linkProjections.filter(
        (p) => p.sourceObjectTypeId === typeId || p.targetObjectTypeId === typeId
      ),
      telemetry: projections.telemetryProjections.filter((p) => p.objectTypeId === typeId),
    }
  }, [projections, typeId])

  const projectionCount =
    typeProjections.object.length + typeProjections.link.length + typeProjections.telemetry.length
  const resolvedTab: TabValue =
    activeTab === "projections" && projectionCount === 0 ? DEFAULT_TAB : activeTab

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingState label="Loading type..." />
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
  const displayTitle = humanizeIdentifier(objectType.name || objectType.id)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      {!embedded ? (
        <div className="flex items-center justify-between gap-3">
          <BackNav to="/ontology" label="Ontology" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/ontology?type=${encodeURIComponent(objectType.id)}`)}
          >
            <Network /> Show in graph
          </Button>
        </div>
      ) : null}

      {/* Header */}
      <header className="space-y-4">
        <div className="flex items-start gap-4">
          <LetterAvatar label={displayTitle} size="md" />
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {displayTitle}
            </h1>
            {objectType.description ? (
              <p className="text-sm leading-6 text-muted-foreground">{objectType.description}</p>
            ) : null}
          </div>
        </div>

        {/* Inheritance chain */}
        {ancestors.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium uppercase tracking-wider text-[11px]">Inherits</span>
            <div className="flex flex-wrap items-center gap-1">
              {ancestors.map((ancestor, index) => (
                <Fragment key={ancestor.id}>
                  <Button
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() => selectType(ancestor.id)}
                  >
                    {humanizeIdentifier(ancestor.name || ancestor.id)}
                  </Button>
                  {index < ancestors.length - 1 ? (
                    <ChevronRight className="h-3 w-3 text-muted-foreground/60" />
                  ) : null}
                </Fragment>
              ))}
            </div>
          </div>
        ) : null}

        {/* Subtypes */}
        {subtypes.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-medium uppercase tracking-wider text-[11px]">Extended by</span>
            <div className="flex flex-wrap items-center gap-2">
              {subtypes.map((subtype) => (
                <Button
                  key={subtype.id}
                  variant="link"
                  className="h-auto p-0 text-xs"
                  onClick={() => selectType(subtype.id)}
                >
                  {humanizeIdentifier(subtype.name || subtype.id)}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </header>

      {/* Tabs */}
      <Tabs value={resolvedTab} onValueChange={setActiveTab}>
        <div className="relative">
          <div className="atlas-tabs-scroll overflow-x-auto overscroll-x-contain pr-8 sm:pr-0">
            <TabsList variant="line" className="min-w-max">
              <TabsTrigger value="properties">
                Properties
                <Count value={objectType.properties.length} />
              </TabsTrigger>
              <TabsTrigger value="links">
                Links
                <Count value={objectType.links.length} />
              </TabsTrigger>
              <TabsTrigger value="actions">
                Actions
                <Count value={objectType.actions.length} />
              </TabsTrigger>
              {projectionCount > 0 ? (
                <TabsTrigger value="projections">
                  Projections
                  <Count value={projectionCount} />
                </TabsTrigger>
              ) : null}
            </TabsList>
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent sm:hidden"
          />
        </div>

        {/* Properties */}
        <TabsContent value="properties" className="space-y-6 pt-4">
          {staticProps.length > 0 ? (
            <PropertiesSection title="Static properties" properties={staticProps} />
          ) : null}
          {telemetryProps.length > 0 ? (
            <PropertiesSection title="Telemetry properties" properties={telemetryProps} />
          ) : null}
          {objectType.properties.length === 0 ? (
            <EmptySection text="No properties defined." />
          ) : null}
        </TabsContent>

        {/* Links */}
        <TabsContent value="links" className="pt-4">
          {objectType.links.length === 0 ? (
            <EmptySection text="No links defined." />
          ) : (
            <Card className="overflow-hidden p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Target</TableHead>
                    <TableHead>Cardinality</TableHead>
                    <TableHead className="hidden md:table-cell">Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {objectType.links.map((link) => {
                    const targets = Array.isArray(link.targetObjectTypeId)
                      ? link.targetObjectTypeId
                      : [link.targetObjectTypeId]
                    return (
                      <TableRow key={link.id}>
                        <TableCell>
                          <span className="font-mono text-xs text-foreground">
                            {humanizeIdentifier(link.name || link.id)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            {targets.map((targetId) =>
                              targetId === "*" ? (
                                <span
                                  key={targetId}
                                  className="text-xs italic text-muted-foreground"
                                >
                                  any type
                                </span>
                              ) : (
                                <Button
                                  key={targetId}
                                  variant="link"
                                  className="h-auto p-0 font-mono text-xs"
                                  onClick={() => selectType(targetId)}
                                >
                                  {targetId}
                                </Button>
                              )
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {link.cardinality ? (
                            <Badge variant="outline" className="text-[10px]">
                              {link.cardinality}
                            </Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                          {link.description || <span className="text-muted-foreground/50">—</span>}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* Actions */}
        <TabsContent value="actions" className="space-y-3 pt-4">
          {objectType.actions.length === 0 ? (
            <EmptySection text="No actions defined." />
          ) : (
            objectType.actions.map((action) => (
              <Card key={action.id} className="space-y-3 p-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h3 className="font-mono text-sm font-medium text-foreground">{action.id}</h3>
                    {action.params.length === 0 ? (
                      <span className="text-xs text-muted-foreground">no parameters</span>
                    ) : null}
                  </div>
                  {action.description ? (
                    <p className="text-xs leading-5 text-muted-foreground">{action.description}</p>
                  ) : null}
                </div>

                {action.params.length > 0 ? (
                  <div className="space-y-1.5 rounded-md border border-border bg-muted/40 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Parameters
                    </p>
                    <ul className="space-y-1">
                      {action.params.map((param) => (
                        <li
                          key={param.id}
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-xs"
                        >
                          <span className="text-foreground">{param.id}</span>
                          <span className="text-muted-foreground/50">:</span>
                          <SchemaType schema={param.schema} />
                          {param.required ? (
                            <Badge variant="outline" className="font-sans text-[9px]">
                              required
                            </Badge>
                          ) : null}
                          {param.description ? (
                            <span className="font-sans text-[11px] text-muted-foreground">
                              {param.description}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </Card>
            ))
          )}
        </TabsContent>

        {/* Projections */}
        {projectionCount > 0 ? (
          <TabsContent value="projections" className="space-y-6 pt-4">
            {typeProjections.object.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Object projections
                </h3>
                <div className="space-y-3">
                  {typeProjections.object.map((proj) => (
                    <Card key={proj.id} className="space-y-4 p-4">
                      <ProjectionHeader id={proj.id} datasetId={proj.datasetId} />
                      <PropertyMappings entries={Object.entries(proj.properties)} />
                      <ForeignKeys links={proj.links} onSelectType={selectType} />
                    </Card>
                  ))}
                </div>
              </section>
            ) : null}

            {typeProjections.link.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Link projections
                </h3>
                <div className="space-y-3">
                  {typeProjections.link.map((proj) => (
                    <Card key={proj.id} className="space-y-3 p-4">
                      <ProjectionHeader id={proj.id} datasetId={proj.datasetId} />

                      <div className="space-y-1.5">
                        <SectionLabel>Join</SectionLabel>
                        <div className="flex flex-wrap items-baseline gap-1.5 font-mono text-xs">
                          <Button
                            variant="link"
                            className="h-auto p-0 font-mono text-xs"
                            onClick={() => selectType(proj.sourceObjectTypeId)}
                          >
                            {proj.sourceObjectTypeId}
                          </Button>
                          <span className="text-muted-foreground/60">.{proj.sourceField}</span>
                          <span aria-hidden="true" className="text-muted-foreground/40">
                            →
                          </span>
                          <Button
                            variant="link"
                            className="h-auto p-0 font-mono text-xs"
                            onClick={() => selectType(proj.targetObjectTypeId)}
                          >
                            {proj.targetObjectTypeId}
                          </Button>
                          <span className="text-muted-foreground/60">.{proj.targetField}</span>
                        </div>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            ) : null}

            {typeProjections.telemetry.length > 0 ? (
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Telemetry projections
                </h3>
                <div className="space-y-3">
                  {typeProjections.telemetry.map((proj) => (
                    <Card key={proj.id} className="space-y-4 p-4">
                      <ProjectionHeader id={proj.id} datasetId={proj.datasetId} />
                      <div className="space-y-1.5">
                        <SectionLabel>Point mapping</SectionLabel>
                        <dl className="grid grid-cols-[max-content_max-content_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 font-mono text-xs">
                          <TelemetryMappingRow label={proj.propertyId} column={proj.valueField} />
                          <TelemetryMappingRow label="at" column={proj.atField} />
                          <TelemetryMappingRow label="object" column={proj.objectIdField} />
                          {proj.unitField ? (
                            <TelemetryMappingRow label="unit" column={proj.unitField} />
                          ) : null}
                        </dl>
                      </div>
                    </Card>
                  ))}
                </div>
              </section>
            ) : null}
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

function Count({ value }: { value: number }) {
  return (
    <span
      className={cn(
        "ml-1.5 inline-flex items-center justify-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums",
        value === 0 && "opacity-50"
      )}
    >
      {value}
    </span>
  )
}

function PropertiesSection({
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
  const anyDescriptions = properties.some((p) => p.description)
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              {anyDescriptions ? (
                <TableHead className="hidden md:table-cell">Description</TableHead>
              ) : null}
              <TableHead className="text-right">Flags</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {properties.map((prop) => (
              <TableRow key={prop.id}>
                <TableCell className="align-top">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{prop.id}</span>
                    {prop.primary ? (
                      <Badge variant="secondary" className="text-[9px]">
                        primary
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <SchemaType schema={prop.schema} />
                </TableCell>
                {anyDescriptions ? (
                  <TableCell className="hidden align-top text-xs text-muted-foreground md:table-cell">
                    {prop.description || <span className="text-muted-foreground/50">—</span>}
                  </TableCell>
                ) : null}
                <TableCell className="text-right align-top">
                  <div className="inline-flex gap-1">
                    {prop.required ? (
                      <Badge variant="outline" className="text-[9px]">
                        required
                      </Badge>
                    ) : null}
                    {prop.nullable ? (
                      <Badge variant="outline" className="text-[9px]">
                        nullable
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </section>
  )
}

function EmptySection({ text }: { text: string }) {
  return (
    <Card className="overflow-hidden p-8 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
    </Card>
  )
}

function ProjectionHeader({ id, datasetId }: { id: string; datasetId: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="font-mono text-sm font-medium text-foreground">{id}</span>
      <span className="text-xs text-muted-foreground">from</span>
      <code className="font-mono text-xs text-foreground">{datasetId}</code>
    </div>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  )
}

function TelemetryMappingRow({ label, column }: { label: string; column: string }) {
  return (
    <Fragment>
      <dt className="text-foreground">{label}</dt>
      <span aria-hidden="true" className="text-muted-foreground/40">
        ←
      </span>
      <dd className="truncate text-muted-foreground">{column}</dd>
    </Fragment>
  )
}

function PropertyMappings({ entries }: { entries: [string, string][] }) {
  if (entries.length === 0) return null
  const twoUp = entries.length >= 5
  return (
    <div className="space-y-1.5">
      <SectionLabel>Property mappings</SectionLabel>
      <dl
        className={cn(
          "grid items-baseline gap-x-3 gap-y-1 font-mono text-xs",
          "grid-cols-[max-content_max-content_minmax(0,1fr)]",
          twoUp &&
            "md:grid-cols-[max-content_max-content_minmax(0,1fr)_max-content_max-content_minmax(0,1fr)] md:gap-x-10"
        )}
      >
        {entries.map(([propId, column]) => (
          <Fragment key={propId}>
            <dt className="text-foreground">{propId}</dt>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ←
            </span>
            <dd className="truncate text-muted-foreground">{column}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

function ForeignKeys({
  links,
  onSelectType,
}: {
  links: Record<
    string,
    { sourcePropertyId?: string; sourceField?: string; targetObjectTypeId: string }
  >
  onSelectType: (id: string) => void
}) {
  const entries = Object.entries(links)
  if (entries.length === 0) return null
  return (
    <div className="space-y-1.5">
      <SectionLabel>Foreign keys</SectionLabel>
      <dl className="grid grid-cols-[max-content_max-content_max-content_max-content_max-content] items-baseline gap-x-2 gap-y-1 font-mono text-xs">
        {entries.map(([linkId, fk]) => (
          <Fragment key={linkId}>
            <dt className="text-foreground">{linkId}</dt>
            <span aria-hidden="true" className="text-muted-foreground/40">
              →
            </span>
            <dd>
              <Button
                variant="link"
                className="h-auto p-0 font-mono text-xs"
                onClick={() => onSelectType(fk.targetObjectTypeId)}
              >
                {fk.targetObjectTypeId}
              </Button>
            </dd>
            <span aria-hidden="true" className="text-muted-foreground/40">
              via
            </span>
            <dd className="text-muted-foreground">{formatForeignKeySource(fk)}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

function formatForeignKeySource(fk: { sourcePropertyId?: string; sourceField?: string }): string {
  return fk.sourcePropertyId ?? fk.sourceField ?? "unknown"
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * A schema renders on a single (wrapping) line when it is a primitive, an
 * enum, or a container whose element is itself inline. Objects — and any
 * container of objects — expand into a stacked tree instead, so their fields
 * always indent from a single, consistent left edge.
 */
function isInlineSchema(schema: unknown): boolean {
  if (typeof schema === "string") return true
  if (!isSchemaRecord(schema) || typeof schema.type !== "string") return true
  switch (schema.type) {
    case "object":
      return false
    case "array":
      return isInlineSchema(schema.items)
    case "map":
      return isInlineSchema(schema.valueSchema)
    case "valueTypeRef":
      return schema._resolved === undefined || isInlineSchema(schema._resolved)
    default:
      return true
  }
}

/**
 * Renders an ontology property schema in a compact, readable form.
 *
 * Primitives render as their bare type name. Complex schemas expand:
 * enums list their allowed values as chips, objects show their fields,
 * arrays/maps show their element types, and value-type refs show the
 * referenced id (plus the resolved schema when codegen populated it).
 */
function SchemaType({ schema }: { schema: unknown }): ReactNode {
  if (typeof schema === "string") {
    return <SchemaPrimitive>{schema}</SchemaPrimitive>
  }
  if (!isSchemaRecord(schema) || typeof schema.type !== "string") {
    return <SchemaPrimitive>unknown</SchemaPrimitive>
  }

  switch (schema.type) {
    case "enum":
      return <EnumType schema={schema} />
    case "object":
      return <ObjectType schema={schema} />
    case "array":
      return (
        <SchemaContainer
          head={<SchemaKeyword>array</SchemaKeyword>}
          lead="of"
          child={schema.items}
        />
      )
    case "map":
      return (
        <SchemaContainer
          head={
            <>
              <SchemaKeyword>map</SchemaKeyword>
              <SchemaPrimitive>string</SchemaPrimitive>
            </>
          }
          lead="→"
          child={schema.valueSchema}
        />
      )
    case "valueTypeRef":
      return (
        <SchemaContainer
          head={
            <span className="font-mono text-xs text-foreground">{String(schema.valueTypeId)}</span>
          }
          lead={schema._resolved === undefined ? undefined : "ref →"}
          child={schema._resolved}
        />
      )
    default:
      return <SchemaPrimitive>{schema.type}</SchemaPrimitive>
  }
}

/**
 * Lays out a container schema (`array`, `map`, `valueTypeRef`) as `<head> lead
 * <child>`. When the child is inline it stays on one wrapping line; when the
 * child is a block (an object), the head sits on its own line with the child
 * indented beneath it — never vertically centered against a tall block.
 */
function SchemaContainer({
  head,
  lead,
  child,
}: {
  head: ReactNode
  lead?: string
  child: unknown
}) {
  if (child === undefined) {
    return <span className="inline-flex flex-wrap items-center gap-1.5">{head}</span>
  }
  if (isInlineSchema(child)) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {head}
        {lead ? <SchemaLead>{lead}</SchemaLead> : null}
        <SchemaType schema={child} />
      </span>
    )
  }
  return (
    <div className="space-y-1">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {head}
        {lead ? <SchemaLead>{lead}</SchemaLead> : null}
      </span>
      <SchemaNest>
        <SchemaType schema={child} />
      </SchemaNest>
    </div>
  )
}

function SchemaPrimitive({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-muted-foreground">{children}</span>
}

function SchemaLead({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-medium text-muted-foreground/70">{children}</span>
}

function SchemaNest({ children }: { children: ReactNode }) {
  return <div className="border-l border-border pl-3">{children}</div>
}

function SchemaKeyword({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </span>
  )
}

function EnumType({ schema }: { schema: Record<string, unknown> }) {
  const values = Array.isArray(schema.values) ? schema.values : []
  const valueType = typeof schema.valueType === "string" ? schema.valueType : null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <SchemaKeyword>enum</SchemaKeyword>
      {valueType ? <SchemaLead>{valueType}</SchemaLead> : null}
      {values.map((value, index) => (
        <span
          key={index}
          className="inline-flex items-center rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground"
        >
          {String(value)}
        </span>
      ))}
    </span>
  )
}

function ObjectType({ schema }: { schema: Record<string, unknown> }) {
  const properties = isSchemaRecord(schema.properties) ? schema.properties : {}
  const entries = Object.entries(properties)
  return (
    <div className="space-y-1">
      <SchemaKeyword>object</SchemaKeyword>
      {entries.length > 0 ? (
        <SchemaNest>
          <div className="space-y-1.5">
            {entries.map(([name, field]) => {
              const fieldSchema = isSchemaRecord(field) ? field.schema : field
              const required = isSchemaRecord(field) && field.required === true
              const inline = isInlineSchema(fieldSchema)
              return (
                <div key={name} className="space-y-1">
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <span className="font-mono text-xs text-foreground">{name}</span>
                    {required ? <SchemaLead>required</SchemaLead> : null}
                    {inline ? <SchemaType schema={fieldSchema} /> : null}
                  </div>
                  {inline ? null : (
                    <SchemaNest>
                      <SchemaType schema={fieldSchema} />
                    </SchemaNest>
                  )}
                </div>
              )
            })}
          </div>
        </SchemaNest>
      ) : null}
    </div>
  )
}
