import { useObjectsFacets, useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { useState } from "react"
import { Customer } from "../../ontology/customer"
import { Employee } from "../../ontology/employee"
import { Project } from "../../ontology/project"

type ProjectStatus = "draft" | "active" | "paused" | "completed" | "cancelled"
type QueryRow<TQuery> = TQuery extends { first(): Promise<infer TRow> } ? NonNullable<TRow> : never

const allProjects = objects(Project)
  .query()
  .expand(Project.l.customer, (customer) => customer.expand(Customer.l.accountManager))
  .expand(Project.l.lead, (lead) => lead.expand(Employee.l.department))
  .expand(Project.l.members, {
    limit: 4,
    orderBy: [{ property: Employee.p.name, direction: "asc" }],
  })
  .orderBy(Project.p.deadline, "asc")

type ProjectRow = QueryRow<typeof allProjects>

function formatBudget(value: unknown): string {
  return typeof value === "number"
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(value)
    : "—"
}

function formatDeadline(value: string | Date | undefined): string {
  if (!value) return "No deadline"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value))
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function memberSummary(members: ProjectRow["links"]["members"]): string {
  if (members.length === 0) return "No assigned members"
  const names = members.map((member) => member.properties.name)
  return names.length < 4
    ? names.join(", ")
    : `${names.slice(0, 3).join(", ")} +${names.length - 3}`
}

function ProjectCard({ project }: { project: ProjectRow }) {
  const customer = project.links.customer
  const accountManager = customer?.links.accountManager
  const lead = project.links.lead
  const department = lead?.links.department

  return (
    <article className="grid grid-cols-[minmax(0,1fr)_auto] gap-5 rounded-lg border border-border/80 bg-card px-4 py-4 shadow-sm transition hover:-translate-y-px hover:border-primary/50 hover:bg-accent/20 max-md:grid-cols-1">
      <div>
        <span className="inline-flex min-h-7 items-center rounded-full border border-primary/10 bg-accent px-3 text-xs font-bold text-accent-foreground capitalize">
          {project.properties.status}
        </span>
        <h2 className="mt-3 text-base font-semibold text-foreground">{project.properties.name}</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          {project.properties.description ?? "No description."}
        </p>
        <dl className="mt-4 grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
          <div>
            <dt className="text-xs font-bold tracking-wide text-foreground uppercase">Customer</dt>
            <dd className="mt-1 text-foreground">{customer?.properties.company ?? "Unassigned"}</dd>
            <dd className="text-xs">
              {accountManager ? `AM: ${accountManager.properties.name}` : "No account manager"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold tracking-wide text-foreground uppercase">Lead</dt>
            <dd className="mt-1 text-foreground">{lead?.properties.name ?? "Unassigned"}</dd>
            <dd className="text-xs">{department?.properties.name ?? "No department"}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold tracking-wide text-foreground uppercase">Team</dt>
            <dd className="mt-1 text-foreground">{memberSummary(project.links.members)}</dd>
          </div>
        </dl>
      </div>
      <div className="grid min-w-44 content-center gap-1.5 text-right text-sm text-muted-foreground max-md:min-w-0 max-md:text-left">
        <span>{formatBudget(project.properties.budget)}</span>
        <span>{formatDeadline(project.properties.deadline)}</span>
      </div>
    </article>
  )
}

function HeaderLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      className="inline-flex h-10 items-center justify-center rounded-lg border border-border/80 bg-card px-4 text-sm font-semibold text-foreground no-underline shadow-sm transition hover:-translate-y-px hover:border-primary/50 hover:text-primary"
      href={href}
    >
      {children}
    </a>
  )
}

export default function ProjectsPage() {
  const [statusFilter, setStatusFilter] = useState<ProjectStatus | null>(null)

  const projectsQuery = useObjectsQuery(
    statusFilter
      ? allProjects.where((project) => project.p.status.eq(statusFilter))
      : allProjects.where((project) => project.p.status.in(["active", "paused"]))
  )

  const statusFacets = useObjectsFacets(objects(Project).query(), [
    { property: Project.p.status, limit: 10 },
  ])

  const projects = projectsQuery.data?.objects ?? []
  const buckets = statusFacets.data?.[0]?.buckets ?? []
  const scopeLabel = statusFilter ?? "open"

  return (
    <main className="mx-auto min-h-dvh w-full max-w-6xl px-5 pt-12 pb-12 max-md:pt-7">
      <header className="mb-7 grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="max-w-3xl">
          <p className="text-xs font-bold tracking-[0.18em] text-primary uppercase">
            Acme Projects
          </p>
          <h1 className="mt-2 text-4xl leading-tight font-semibold tracking-normal text-foreground max-md:text-3xl">
            {statusFilter ? `${titleCase(statusFilter)} projects` : "Open projects"}
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">
            Track customer work, owners, deadlines, and active delivery status.
          </p>
        </div>
        <div className="flex items-center gap-3 max-md:flex-wrap">
          <HeaderLink href="/">Review desk</HeaderLink>
          <div className="grid h-16 min-w-20 place-items-center rounded-lg border border-primary/15 bg-accent px-4 text-center shadow-sm">
            <span className="text-2xl leading-none font-semibold text-accent-foreground">
              {projectsQuery.data?.total ?? 0}
            </span>
            <small className="mt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              {scopeLabel}
            </small>
          </div>
        </div>
      </header>

      <section className="mb-5 flex flex-wrap gap-2" aria-label="Filter projects by status">
        {buckets.map((bucket) => {
          const status = String(bucket.value) as ProjectStatus
          const selected = statusFilter === status
          return (
            <button
              key={status}
              type="button"
              aria-pressed={selected}
              className={
                selected
                  ? "inline-flex min-h-7 items-center rounded-full border border-primary bg-primary px-3 text-xs font-bold text-primary-foreground capitalize transition"
                  : "inline-flex min-h-7 items-center rounded-full border border-border/80 bg-secondary px-3 text-xs font-bold text-muted-foreground capitalize transition hover:border-primary/50 hover:text-primary"
              }
              onClick={() => setStatusFilter(selected ? null : status)}
            >
              {status}: {bucket.count}
            </button>
          )
        })}
      </section>

      {projectsQuery.isLoading ? (
        <section className="rounded-lg border border-border/80 bg-card px-5 py-14 text-center shadow-sm">
          <p>Loading projects...</p>
        </section>
      ) : projectsQuery.isError ? (
        <section className="rounded-lg border border-destructive/30 bg-destructive/10 px-5 py-14 text-center text-destructive shadow-sm">
          <p>Projects failed to load.</p>
        </section>
      ) : projects.length === 0 ? (
        <section className="rounded-lg border border-border/80 bg-card px-6 py-16 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-foreground">No {scopeLabel} projects</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            {statusFilter
              ? "Select the pill again to clear the filter."
              : "Active and paused projects will appear here."}
          </p>
        </section>
      ) : (
        <section className="grid gap-3" aria-label="Projects">
          {projects.map((project) => (
            <ProjectCard key={project.primaryId} project={project} />
          ))}
        </section>
      )}
    </main>
  )
}
