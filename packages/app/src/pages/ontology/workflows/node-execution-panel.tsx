import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sixb/ui/components"
import { ScrollText } from "lucide-react"
import { FailureSummary } from "../../section-ui"
import { type FileLinksAt, type ValueSchema, ValueTree } from "../../values"
import { RunDebugSection, RunMetadataRows, stringifyRunDebugValue } from "./run-debug-section"
import { formatDate, type WorkflowRunNode } from "./utils"

export function WorkflowNodeExecutionPanel({
  node,
  inputSchema,
  outputSchema,
  inputFileLinks,
  outputFileLinks,
}: {
  node: WorkflowRunNode
  /** Declared schemas of the recorded IO; omitted where nothing declares it. */
  inputSchema?: ValueSchema
  outputSchema?: ValueSchema
  inputFileLinks: FileLinksAt
  outputFileLinks: FileLinksAt
}) {
  const outputLabel = node.nodeType === "intervention" ? "Response" : "Output"
  const raw = stringifyRunDebugValue(node)
  const metadata = [
    ["Node type", node.nodeType],
    ["Definition ID", node.nodeId],
    ["Node run ID", node.id],
    ["Started", formatDate(node.startedAt)],
    ["Finished", formatDate(node.finishedAt)],
  ] as const

  return (
    <div className="space-y-4">
      {node.error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-destructive">
            Execution failed
          </p>
          <FailureSummary failure={node.error} />
        </div>
      ) : null}

      <Tabs defaultValue={node.error ? "input" : "output"} className="gap-3">
        <TabsList variant="line" className="h-9 w-full border-b border-border/70">
          <TabsTrigger value="input">Input</TabsTrigger>
          <TabsTrigger value="output">{outputLabel}</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        <TabsContent value="input" className="mt-0">
          <ValueTree
            value={node.input}
            schema={inputSchema}
            emptyLabel="No input"
            fileLinks={inputFileLinks}
          />
        </TabsContent>

        <TabsContent value="output" className="mt-0">
          <ValueTree
            value={node.output ?? null}
            schema={outputSchema}
            emptyLabel={`No ${outputLabel.toLowerCase()}`}
            fileLinks={outputFileLinks}
          />
        </TabsContent>

        <TabsContent value="details" className="mt-0 space-y-5">
          <RunDebugSection label="Execution">
            <RunMetadataRows rows={metadata} />
          </RunDebugSection>
          <RunDebugSection label="Raw execution record" copyValue={raw}>
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                <ScrollText className="size-3.5" /> View exact API response
              </summary>
              <pre className="scrollbar-thin mt-3 max-h-96 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground">
                {raw}
              </pre>
            </details>
          </RunDebugSection>
        </TabsContent>
      </Tabs>
    </div>
  )
}
