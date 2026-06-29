import { listWorkflowsOptions } from "@sixb/client/hooks"
import { Card, EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@sixb/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Workflow } from "lucide-react"
import { useSearchParams } from "react-router-dom"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { WorkflowRunHistoryTab } from "../features/workflows/components/runs/WorkflowRunHistoryTab"
import { WorkflowCard } from "../features/workflows/components/workflows/WorkflowCard"
import { useWorkflowLiveUpdates } from "../features/workflows/hooks/useWorkflowLiveUpdates"

type WorkflowsPageTab = "workflows" | "runs"

export function WorkflowsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const activeTab: WorkflowsPageTab = searchParams.get("tab") === "runs" ? "runs" : "workflows"
  useWorkflowLiveUpdates()

  const handleTabChange = (value: string) => {
    const nextTab: WorkflowsPageTab = value === "runs" ? "runs" : "workflows"
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous)
      params.set("tab", nextTab)
      return params
    })
  }

  return (
    <PageFrame
      eyebrow="Atlas"
      title="Workflows"
      description="Browse workflow definitions, trigger runs, and inspect execution history."
    >
      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-4">
        <TabsList variant="line" className="border-b border-border">
          <TabsTrigger value="workflows">Workflows</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="workflows" className="mt-0">
          <WorkflowDefinitionsTab />
        </TabsContent>
        <TabsContent value="runs" className="mt-0">
          <WorkflowRunHistoryTab />
        </TabsContent>
      </Tabs>
    </PageFrame>
  )
}

function WorkflowDefinitionsTab() {
  const workflowsQuery = useQuery(listWorkflowsOptions())
  const workflows = workflowsQuery.data ?? []

  if (workflowsQuery.isLoading) {
    return <LoadingPage label="Loading workflows..." />
  }

  if (workflowsQuery.isError) {
    return (
      <ErrorPage title="Workflows unavailable" description="Could not load workflow metadata." />
    )
  }

  return (
    <section className="space-y-3">
      {workflows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Workflow className="size-12 stroke-1" />}
            title="No workflows registered"
            description="Create a workflow definition to see it appear here."
          />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {workflows.map((workflow) => (
            <WorkflowCard key={workflow.id} workflow={workflow} />
          ))}
        </div>
      )}
    </section>
  )
}
