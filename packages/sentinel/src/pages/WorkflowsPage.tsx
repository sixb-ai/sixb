import { listWorkflowsOptions } from "@pario/client/hooks"
import { Card } from "@pario/ui/components"
import { useQuery } from "@tanstack/react-query"
import { Workflow } from "lucide-react"
import type { ReactNode } from "react"
import { ErrorPage, LoadingPage, PageFrame } from "../components/common"
import { WorkflowCard } from "../features/workflows/components/workflows/WorkflowCard"

export function WorkflowsPage() {
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
    <PageFrame
      eyebrow="Sentinel"
      title="Workflows"
      description="Browse registered workflow definitions and inspect their inputs, steps, and triggers."
    >
      <section className="space-y-3">
        {workflows.length === 0 ? (
          <Card>
            <QuietEmptyState
              icon={<Workflow className="h-5 w-5" />}
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
    </PageFrame>
  )
}

function QuietEmptyState({
  icon,
  title,
  description,
}: {
  icon: ReactNode
  title: string
  description: string
}) {
  return (
    <div className="px-5 py-14 text-center">
      <div className="mx-auto text-muted-foreground">{icon}</div>
      <p className="mt-4 font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
