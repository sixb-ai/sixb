import { listWorkflowsOptions } from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import { Search, Workflow } from "lucide-react"
import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { SectionPage } from "../../section-page"
import { PanelEmpty, PanelSkeleton, useLoadFailure } from "../../section-ui"
import { CollectionToolbar } from "./components/collection-toolbar"
import { useWorkflowLiveUpdates } from "./hooks/workflow-live-updates"
import { humanizeIdentifier } from "./lib/labels"
import type { WorkflowSummary } from "./workflows/utils"
import { WorkflowCard } from "./workflows/workflow-card"

/** Console › Workflows: every workflow with its latest run; each opens its canvas. */
export function ConsoleWorkflowsPage() {
  useWorkflowLiveUpdates()
  const count = useQuery({ ...listWorkflowsOptions(), retry: false }).data?.length
  return (
    <SectionPage
      section="console"
      page="workflows"
      width="wide"
      title="Workflows"
      meta={
        count === undefined ? undefined : (
          <span>{`${count} workflow${count === 1 ? "" : "s"}`}</span>
        )
      }
    >
      <WorkflowDefinitionsTab />
    </SectionPage>
  )
}

function WorkflowDefinitionsTab() {
  const workflowsQuery = useQuery({ ...listWorkflowsOptions(), retry: false })
  const [searchParams, setSearchParams] = useSearchParams()
  const workflows = workflowsQuery.data ?? []
  const query = searchParams.get("q") ?? ""
  const filteredWorkflows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return workflows
    return workflows.filter((workflow) => workflowSearchText(workflow).includes(normalizedQuery))
  }, [query, workflows])

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

  if (workflowsQuery.isPending) {
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <PanelSkeleton rows={4} />
      </div>
    )
  }

  if (workflowsQuery.isError) {
    return <WorkflowsFailure error={workflowsQuery.error} />
  }

  if (workflows.length === 0) {
    return (
      <PanelEmpty
        icon={Workflow}
        title="No workflows registered"
        description="Create a workflow definition to see it appear here."
      />
    )
  }

  return (
    <section className="-mt-4 space-y-4">
      <CollectionToolbar
        search={{
          value: query,
          onChange: updateQuery,
          placeholder: "Search workflows, nodes, triggers, or inputs…",
        }}
        // The header counts every workflow; while searching, this counts the matches.
        actions={
          query.trim() ? (
            <p className="px-1 text-xs tabular-nums text-muted-foreground">
              {`${filteredWorkflows.length} of ${workflows.length} workflows`}
            </p>
          ) : undefined
        }
      />

      {filteredWorkflows.length === 0 ? (
        <PanelEmpty
          icon={Search}
          title="No matching workflows"
          description="Try another workflow name, node, trigger, or input."
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {filteredWorkflows.map((workflow) => (
            <WorkflowCard key={workflow.id} workflow={workflow} />
          ))}
        </div>
      )}
    </section>
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
    ...Object.keys(workflow.input ?? {}),
    ...workflow.triggers.map((trigger) => trigger.scheduleId),
    ...nodeValues,
  ]
    .join(" ")
    .toLowerCase()
}
