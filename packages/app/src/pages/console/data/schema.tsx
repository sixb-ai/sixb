import { KeyRound } from "lucide-react"
import { PageSection, Panel } from "../../section-ui"
import { useDataMessages } from "./messages"

interface DatasetShape {
  readonly id: string
  readonly description?: string
  readonly primaryKey?: string | readonly string[]
  readonly sequenceBy?: string
  readonly partitionBy?: readonly string[]
  readonly schema: {
    readonly columns: readonly {
      readonly name: string
      readonly type: string
      readonly nullable?: boolean
    }[]
  }
}

/** A dataset's columns and keys, as declared. */
export function SchemaPanel({ dataset }: { readonly dataset: DatasetShape }) {
  const messages = useDataMessages().common
  const primaryKey = new Set(
    typeof dataset.primaryKey === "string" ? [dataset.primaryKey] : (dataset.primaryKey ?? [])
  )
  const notes = [
    dataset.sequenceBy ? `${messages.sequenceBy} ${dataset.sequenceBy}` : null,
    dataset.partitionBy?.length
      ? `${messages.partitionBy} ${dataset.partitionBy.join(", ")}`
      : null,
  ].filter((note): note is string => note !== null)

  return (
    <PageSection
      title={messages.schema}
      description={messages.columns(dataset.schema.columns.length)}
    >
      <Panel footer={notes.length > 0 ? notes.join(" · ") : undefined}>
        {dataset.schema.columns.map((column) => (
          <div
            key={column.name}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-2.5 text-[0.8125rem]"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-xs">{column.name}</span>
              {primaryKey.has(column.name) ? (
                <KeyRound
                  className="size-3.5 shrink-0 text-amber-500"
                  aria-label={messages.primaryKey}
                />
              ) : null}
            </span>
            <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
              {column.type}
              {column.nullable ? <span className="font-sans">· {messages.nullable}</span> : null}
            </span>
          </div>
        ))}
      </Panel>
    </PageSection>
  )
}
