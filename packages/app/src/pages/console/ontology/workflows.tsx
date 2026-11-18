import { listWorkflowsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Search, Workflow } from "lucide-react"
import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { FolderContents, noItems, useFolderBrowser } from "../../folders"
import { SectionPage } from "../../section-page"
import { PanelEmpty, useLoadFailure } from "../../section-ui"
import { CardSkeleton, CountSkeleton } from "../skeletons"
import { CollectionToolbar } from "./components/collection-toolbar"
import { useWorkflowLiveUpdates } from "./hooks/workflow-live-updates"
import { humanizeIdentifier } from "./lib/labels"
import type { WorkflowSummary } from "./workflows/utils"
import { WorkflowCard } from "./workflows/workflow-card"

/** Console › Workflows: every workflow with its latest run; each opens its canvas. */
export function ConsoleWorkflowsPage() {
  useWorkflowLiveUpdates()
  const workflowsQuery = useQuery({ ...listWorkflowsOptions(), retry: false })
  const [searchParams, setSearchParams] = useSearchParams()
  const workflows = workflowsQuery.data ?? noItems
  const count = workflowsQuery.data?.length
  const query = searchParams.get("q") ?? ""
  const normalizedQuery = query.trim().toLowerCase()
  const filteredWorkflows = useMemo(() => {
    if (!normalizedQuery) return workflows
    return workflows.filter((workflow) => workflowSearchText(workflow).includes(normalizedQuery))
  }, [normalizedQuery, workflows])
  const browser = useFolderBrowser({
    items: filteredWorkflows,
    title: "Workflows",
    meta: workflowsQuery.isPending ? (
      <CountSkeleton />
    ) : count === undefined ? undefined : (
      <span>{`${count} workflow${count === 1 ? "" : "s"}`}</span>
    ),
    narrowed: normalizedQuery.length > 0,
  })

  const updateQuery = (value: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        if (value) next.set("q", value)
        else next.delete("q")
        return next
      },
      { replace: true }
    )
  }

  const toolbar = (
    <CollectionToolbar
      search={{
        value: query,
        onChange: updateQuery,
        placeholder: "Search workflows, folders, nodes, triggers, or inputs…",
      }}
      // The header counts every workflow; while searching, this counts the matches.
      actions={
        normalizedQuery && !workflowsQuery.isPending ? (
          <p className="px-1 text-xs tabular-nums text-muted-foreground">
            {`${filteredWorkflows.length} of ${workflows.length} workflows`}
          </p>
        ) : undefined
      }
    />
  )

  return (
    <SectionPage section="console" page="workflows" width="wide" {...browser.frame}>
      {workflowsQuery.isPending ? (
        <section className="-mt-4 space-y-4">
          {toolbar}
          <div className="grid gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <CardSkeleton key={index} />
            ))}
          </div>
        </section>
      ) : workflowsQuery.isError ? (
        <WorkflowsFailure error={workflowsQuery.error} />
      ) : workflows.length === 0 ? (
        <PanelEmpty
          icon={Workflow}
          title="No workflows registered"
          description="Create a workflow definition to see it appear here."
        />
      ) : (
        <section className="-mt-4 space-y-4">
          {toolbar}
          {filteredWorkflows.length === 0 ? (
            <PanelEmpty
              icon={Search}
              title="No matching workflows"
              description="Try another workflow name, folder, node, trigger, or input."
            />
          ) : (
            <FolderContents browser={browser} rootLabel="Workflows">
              {(shown) => (
                <div className="grid gap-3 lg:grid-cols-2">
                  {shown.map((workflow) => (
                    <WorkflowCard key={workflow.id} workflow={workflow} />
                  ))}
                </div>
              )}
            </FolderContents>
          )}
        </section>
      )}
    </SectionPage>
  )
}

function WorkflowsFailure({ error }: { readonly error: unknown }) {
  const failure = useLoadFailure(error)
  return (
    <PanelEmpty
      tone="error"
      icon={Workflow}
      title={failure.title}
      description={failure.description}
    />
  )
}

function workflowSearchText(workflow: WorkflowSummary): string {
  const nodeValues = workflow.nodes.flatMap((node) => [
    node.key,
    node.type,
    "objectTypeId" in node ? (node.objectTypeId ?? "") : "",
    "agentId" in node ? node.agentId : "",
  ])
  return [
    workflow.id,
    humanizeIdentifier(workflow.id),
    workflow.folder ?? "",
    ...Object.keys(workflow.input ?? {}),
    ...workflow.triggers.map((trigger) => trigger.scheduleId),
    ...nodeValues,
  ]
    .join(" ")
    .toLowerCase()
}
