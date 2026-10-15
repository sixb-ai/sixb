import { listWorkflowsOptions } from "@sixb/client/hooks"
import { Card, EmptyState } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Search, Workflow } from "lucide-react"
import { useMemo } from "react"
import { useSearchParams } from "react-router-dom"
import { CollectionSearchInput } from "../components/CollectionPageHeader"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { MovedToApp } from "../components/MovedToApp"
import { WorkflowCard } from "../features/workflows/components/workflows/WorkflowCard"
import { useWorkflowLiveUpdates } from "../features/workflows/hooks/useWorkflowLiveUpdates"
import type { WorkflowSummary } from "../features/workflows/utils/workflows"
import { projectAppUrl, workflowRunsInApp } from "../lib/app-url"
import { humanizeIdentifier } from "../lib/labels"

export function WorkflowsPage() {
  const [searchParams] = useSearchParams()
  useWorkflowLiveUpdates()
  // Run history moved into the project's app; without its address the list stays here.
  if (searchParams.get("tab") === "runs" && projectAppUrl("/")) {
    return <MovedToApp to={(location) => workflowRunsInApp(location.search)} />
  }

  return (
    <PageFrame title="Workflows" headerDivider={false}>
      <WorkflowDefinitionsTab />
    </PageFrame>
  )
}

function WorkflowDefinitionsTab() {
  const workflowsQuery = useQuery(listWorkflowsOptions())
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

  if (workflowsQuery.isLoading) {
    return <LoadingPage label="Loading workflows..." />
  }

  if (workflowsQuery.isError) {
    return (
      <ErrorPage title="Workflows unavailable" description="Could not load workflow metadata." />
    )
  }

  if (workflows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<Workflow className="size-12 stroke-1" />}
          title="No workflows registered"
          description="Create a workflow definition to see it appear here."
        />
      </Card>
    )
  }

  return (
    <section className="space-y-4">
      <div className="sticky top-0 z-20 bg-background/92 py-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/82">
        <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
          <CollectionSearchInput
            value={query}
            onChange={updateQuery}
            placeholder="Search workflows, nodes, triggers, or inputs…"
          />
          <p className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
            {query.trim()
              ? `${filteredWorkflows.length} of ${workflows.length} workflows`
              : `${workflows.length} workflow${workflows.length === 1 ? "" : "s"}`}
          </p>
        </div>
      </div>

      {filteredWorkflows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search className="size-10 stroke-1" />}
            title="No matching workflows"
            description="Try another workflow name, node, trigger, or input."
          />
        </Card>
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
