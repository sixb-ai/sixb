import { Tabs, TabsContent, TabsList, TabsTrigger } from "@sixb/ui/components"
import { ScrollText } from "lucide-react"
import { SixbFailureSummary } from "../../../../components/SixbFailureSummary"
import { type FileLinkForPath, StructuredValue } from "../../../../components/StructuredValue"
import { formatDate, type WorkflowRunNode } from "../../utils/workflows"
import { RunDebugSection, RunMetadataRows, stringifyRunDebugValue } from "./RunDebugSection"

export function WorkflowNodeExecutionPanel({
  node,
  inputFileLinkForPath,
  outputFileLinkForPath,
}: {
  node: WorkflowRunNode
  inputFileLinkForPath: FileLinkForPath
  outputFileLinkForPath: FileLinkForPath
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
          <SixbFailureSummary failure={node.error} className="text-sm" />
        </div>
      ) : null}

      <Tabs defaultValue={node.error ? "input" : "output"} className="gap-3">
        <TabsList variant="line" className="h-9 w-full border-b border-border/70">
          <TabsTrigger value="input">Input</TabsTrigger>
          <TabsTrigger value="output">{outputLabel}</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>

        <TabsContent value="input" className="mt-0">
          <StructuredValue
            value={node.input}
            emptyLabel="No input"
            fileLinkForPath={inputFileLinkForPath}
            variant="debug"
          />
        </TabsContent>

        <TabsContent value="output" className="mt-0">
          <StructuredValue
            value={node.output ?? null}
            emptyLabel={`No ${outputLabel.toLowerCase()}`}
            fileLinkForPath={outputFileLinkForPath}
            variant="debug"
          />
        </TabsContent>

        <TabsContent value="details" className="mt-0 space-y-5">
          <RunDebugSection label="Execution">
            <RunMetadataRows rows={metadata} />
          </RunDebugSection>
          <RunDebugSection label="Raw execution record" copyValue={raw} copyLabel="Copy raw run">
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
