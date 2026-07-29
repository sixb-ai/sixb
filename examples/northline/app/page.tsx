import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import {
  Activity,
  ArrowRight,
  Building2,
  Check,
  CircleAlert,
  ClipboardList,
  Tag,
  Truck,
  UsersRound,
  Wrench,
} from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { Equipment } from "../ontology/equipment"
import { ServiceCase } from "../ontology/service-case"
import { deadlineLabel, humanize, QueryState } from "./_components/ui"

const casesQuery = objects(ServiceCase)
  .query()
  .expand(ServiceCase.l.customer)
  .expand(ServiceCase.l.facility)
  .expand(ServiceCase.l.equipment)
  .orderBy(ServiceCase.p.responseDeadline, "asc")
  .limit(30)

const equipmentQuery = objects(Equipment)
  .query()
  .expand(Equipment.l.facility)
  .orderBy(Equipment.p.name, "asc")
  .limit(100)

type CaseRow = NonNullable<Awaited<ReturnType<typeof casesQuery.first>>>
type EquipmentRow = NonNullable<Awaited<ReturnType<typeof equipmentQuery.first>>>

export default function TodayPage() {
  const cases = useObjectsQuery(casesQuery)
  const equipment = useObjectsQuery(equipmentQuery)
  const caseRows = cases.data?.objects ?? []
  const activeCases = caseRows.filter(
    (item) => !["closed", "cancelled"].includes(item.properties.status)
  )
  const attention = activeCases
    .filter(
      (item) =>
        ["new", "triage", "awaiting_authorization", "resolved"].includes(item.properties.status) ||
        ["at_risk", "breached"].includes(item.properties.slaStatus)
    )
    .sort((left, right) => casePriority(right) - casePriority(left))
  const primary = attention[0] ?? activeCases[0]
  const workInMotion = activeCases.filter((item) => item.primaryId !== primary?.primaryId)
  const atRiskEquipment = (equipment.data?.objects ?? [])
    .filter((asset) => asset.properties.health !== "healthy")
    .sort((left, right) => healthPriority(right) - healthPriority(left))
  const needsDecision = activeCases.filter(
    (item) => item.properties.status === "awaiting_authorization"
  ).length

  return (
    <div className="pb-8">
      <TodayHeader />

      <div className="mb-6 flex flex-wrap items-center gap-y-3 text-sm text-foreground">
        <SummaryDatum icon={ClipboardList} value={activeCases.length} label="active cases" />
        <SummaryDivider />
        <SummaryDatum
          icon={UsersRound}
          value={needsDecision}
          label={needsDecision === 1 ? "needs your decision" : "need your decision"}
        />
        <SummaryDivider />
        <SummaryDatum icon={Activity} value={atRiskEquipment.length} label="equipment signals" />
      </div>

      <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1.36fr)_minmax(380px,1fr)]">
        <section className="min-h-[510px] overflow-hidden rounded-xl border border-border/85 bg-card">
          <QueryState
            loading={cases.isLoading}
            error={cases.isError}
            empty={!primary}
            emptyMessage="No service cases require attention."
          >
            {primary ? <PrimaryCase serviceCase={primary} /> : null}
          </QueryState>
        </section>

        <AttentionQueue
          cases={workInMotion.slice(0, 3)}
          loading={cases.isLoading}
          error={cases.isError}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[0.94fr_1.06fr]">
        <TodaysWork
          cases={activeCases.slice(0, 4)}
          loading={cases.isLoading}
          error={cases.isError}
        />
        <EquipmentSignals
          assets={atRiskEquipment.slice(0, 2)}
          loading={equipment.isLoading}
          error={equipment.isError}
        />
      </div>
    </div>
  )
}

function TodayHeader() {
  const date = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date())

  return (
    <header className="mb-5 flex items-center justify-between gap-5 border-b border-border/75 pb-5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1">
        <h1 className="text-[28px] leading-none font-semibold tracking-[-0.035em]">Today</h1>
        <p className="text-sm text-muted-foreground">{date}</p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-2 text-sm font-medium">
        <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
        Live
      </span>
    </header>
  )
}

function SummaryDatum({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof ClipboardList
  value: number
  label: string
}) {
  return (
    <span className="inline-flex items-center gap-3 px-1 sm:min-w-48">
      <Icon className="size-5 text-primary" strokeWidth={1.7} />
      <strong className="text-base font-semibold">{value}</strong>
      <span>{label}</span>
    </span>
  )
}

function SummaryDivider() {
  return <span className="mx-4 hidden h-8 w-px bg-border sm:block" aria-hidden="true" />
}

function PrimaryCase({ serviceCase }: { serviceCase: CaseRow }) {
  return (
    <div className="relative min-h-[510px] overflow-hidden p-6 sm:p-7">
      <div className="relative z-10 md:max-w-[58%]">
        <span className="inline-flex rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
          {humanize(serviceCase.properties.severity)}
        </span>

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="font-mono text-sm font-semibold tracking-[-0.01em]">
            {serviceCase.properties.number}
          </span>
          <span className="ml-auto text-xs font-medium text-primary">
            {sentenceCase(serviceCase.properties.status)}
          </span>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <span className="text-xs font-medium text-destructive">{caseDeadline(serviceCase)}</span>
        </div>

        <h2 className="mt-4 text-[27px] leading-8 font-semibold tracking-[-0.035em]">
          {primaryHeadline(serviceCase.properties.title)}
        </h2>

        <dl className="mt-5 grid gap-2.5 text-sm text-muted-foreground">
          <DetailRow icon={Building2}>
            {serviceCase.links.facility?.properties.name ?? "Facility"}
          </DetailRow>
          <DetailRow icon={Tag}>
            {serviceCase.links.equipment?.properties.name ?? "Equipment"}
          </DetailRow>
          <DetailRow icon={UsersRound}>
            {serviceCase.links.customer?.properties.name ?? "Customer"}
          </DetailRow>
        </dl>

        <p className="mt-5 max-w-md text-sm leading-6 text-muted-foreground">
          {primaryImpact(serviceCase)}
        </p>
      </div>

      <img
        src="/illustrations/boiler-2.webp"
        alt="Isometric illustration of Boiler 2"
        className="absolute top-3 right-3 h-[405px] w-[45%] object-contain object-center max-md:relative max-md:top-auto max-md:right-auto max-md:mx-auto max-md:mt-6 max-md:h-72 max-md:w-full"
      />

      <div className="relative z-10 mt-7 md:absolute md:bottom-7 md:left-7 md:mt-0 md:w-[58%]">
        <CaseProgress />
        <Link
          to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
          className="mt-6 inline-flex min-h-11 w-fit items-center gap-5 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {primaryActionLabel(serviceCase.properties.nextAction)}
          <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  )
}

function DetailRow({ icon: Icon, children }: { icon: typeof Building2; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <dt className="sr-only">Case detail</dt>
      <Icon className="size-4 shrink-0 text-primary" strokeWidth={1.7} aria-hidden="true" />
      <dd className="truncate">{children}</dd>
    </div>
  )
}

function CaseProgress() {
  const stages = [
    { label: "Diagnose", icon: CircleAlert },
    { label: "Plan", icon: Wrench },
    { label: "Dispatch", icon: Truck },
    { label: "Resolve", icon: Check },
  ]

  return (
    <ol className="mt-auto grid grid-cols-4 pt-7" aria-label="Service response progress">
      {stages.map((stage, index) => {
        const active = index === 0
        return (
          <li key={stage.label} className="relative text-center">
            {index < stages.length - 1 ? (
              <span className="absolute top-3 left-1/2 h-px w-full bg-border" aria-hidden="true" />
            ) : null}
            <span
              className={`relative z-10 mx-auto grid size-6 place-items-center rounded-full border bg-card ${
                active ? "border-primary text-primary" : "border-border text-muted-foreground"
              }`}
            >
              <stage.icon className="size-3.5" strokeWidth={1.9} />
            </span>
            <span className="mt-2 block text-[11px] font-medium text-muted-foreground">
              {stage.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function AttentionQueue({
  cases,
  loading,
  error,
}: {
  cases: readonly CaseRow[]
  loading: boolean
  error: boolean
}) {
  return (
    <section className="min-h-[510px] rounded-xl border border-border/85 bg-card p-6">
      <h2 className="text-base font-semibold tracking-[-0.015em]">Needs your attention</h2>
      <QueryState
        loading={loading}
        error={error}
        empty={cases.length === 0}
        emptyMessage="Nothing else needs your attention."
      >
        <div className="mt-4 divide-y divide-border/75">
          {cases.map((serviceCase) => {
            const status = attentionStatus(serviceCase.properties.status)
            return (
              <Link
                key={serviceCase.primaryId}
                to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
                className="group grid min-h-[104px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-4 transition-colors hover:text-primary"
              >
                <span className="grid min-w-0 grid-cols-[74px_minmax(0,1fr)] gap-3">
                  <span className="font-mono text-sm font-medium text-foreground">
                    {serviceCase.properties.number}
                  </span>
                  <span className="min-w-0">
                    <strong className="block text-sm font-medium text-foreground">
                      {serviceCase.properties.nextAction}
                    </strong>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {serviceCase.links.facility?.properties.name ?? "Facility"}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-4">
                  <span className="text-right text-xs">
                    <strong className={`block font-medium ${status.className}`}>
                      {status.label}
                    </strong>
                    <span className="mt-1 block whitespace-nowrap text-muted-foreground">
                      {caseDeadline(serviceCase)}
                    </span>
                  </span>
                  <ArrowRight
                    className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            )
          })}
        </div>
      </QueryState>
    </section>
  )
}

function TodaysWork({
  cases,
  loading,
  error,
}: {
  cases: readonly CaseRow[]
  loading: boolean
  error: boolean
}) {
  return (
    <section className="rounded-xl border border-border/85 bg-card p-6">
      <h2 className="text-base font-semibold tracking-[-0.015em]">Today&apos;s work</h2>
      <QueryState
        loading={loading}
        error={error}
        empty={cases.length === 0}
        emptyMessage="No active work is scheduled."
      >
        <div className="mt-3 divide-y divide-border/70">
          {cases.map((serviceCase) => (
            <Link
              key={serviceCase.primaryId}
              to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
              className="grid grid-cols-[76px_82px_minmax(0,1fr)] items-center gap-3 py-3 text-sm transition-colors hover:text-primary max-sm:grid-cols-[70px_minmax(0,1fr)]"
            >
              <span className="text-xs text-muted-foreground">
                {formatTime(serviceCase.properties.responseDeadline)}
              </span>
              <span className="font-mono text-xs font-medium text-primary">
                {serviceCase.properties.number}
              </span>
              <span className="min-w-0 max-sm:col-span-2 max-sm:pl-[83px]">
                <strong className="block truncate font-medium text-foreground">
                  {shortAction(serviceCase)}
                </strong>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {serviceCase.links.facility?.properties.name ?? "Facility"}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </QueryState>
    </section>
  )
}

function EquipmentSignals({
  assets,
  loading,
  error,
}: {
  assets: readonly EquipmentRow[]
  loading: boolean
  error: boolean
}) {
  return (
    <section className="rounded-xl border border-border/85 bg-card p-6">
      <h2 className="text-base font-semibold tracking-[-0.015em]">Equipment signals</h2>
      <QueryState
        loading={loading}
        error={error}
        empty={assets.length === 0}
        emptyMessage="All monitored equipment is operating normally."
      >
        <div className="mt-3 divide-y divide-border/70">
          {assets.map((asset) => (
            <Link
              key={asset.primaryId}
              to={`/equipment/${encodeURIComponent(asset.primaryId)}`}
              className="group grid grid-cols-[72px_minmax(0,1fr)_minmax(130px,0.62fr)_auto] items-center gap-4 py-3 transition-colors hover:text-primary max-sm:grid-cols-[58px_minmax(0,1fr)_auto]"
            >
              <RooftopUnitArtwork />
              <span className="min-w-0">
                <strong className="block text-sm font-semibold text-primary">
                  {asset.properties.name}
                </strong>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {asset.links.facility?.properties.name ?? "Facility"}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">Rooftop unit</span>
              </span>
              <span className="min-w-0 text-xs max-sm:hidden">
                <strong className="font-medium text-destructive">
                  {humanize(asset.properties.health ?? "watch")}
                </strong>
                <span className="mt-1 block leading-5 text-muted-foreground">
                  {sentenceCase(asset.properties.healthReason ?? "Condition requires review")}
                </span>
              </span>
              <ArrowRight
                className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                aria-hidden="true"
              />
            </Link>
          ))}
        </div>
        <Link
          to="/equipment"
          className="mt-2 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-primary hover:underline"
        >
          View all equipment <ArrowRight className="size-4" />
        </Link>
      </QueryState>
    </section>
  )
}

function RooftopUnitArtwork() {
  return (
    <svg viewBox="0 0 90 64" className="w-full text-primary" aria-hidden="true" focusable="false">
      <path
        d="m7 22 42-16 34 13-42 17z"
        fill="color-mix(in srgb, var(--primary) 14%, var(--card))"
        stroke="currentColor"
        strokeOpacity=".45"
      />
      <path
        d="m7 22 34 14v23L7 45z"
        fill="color-mix(in srgb, var(--primary) 24%, var(--card))"
        stroke="currentColor"
        strokeOpacity=".5"
      />
      <path
        d="m41 36 42-17v23L41 59z"
        fill="color-mix(in srgb, var(--primary) 34%, var(--card))"
        stroke="currentColor"
        strokeOpacity=".55"
      />
      <path d="m52 35 21-8v13l-21 8z" fill="none" stroke="currentColor" strokeOpacity=".65" />
      <path d="m56 35 13-5M56 39l13-5M56 43l13-5" stroke="currentColor" strokeOpacity=".45" />
    </svg>
  )
}

function attentionStatus(status: string): { label: string; className: string } {
  if (status === "awaiting_authorization") {
    return { label: "Decision", className: "text-[color:var(--warning)]" }
  }
  if (["dispatching", "in_service"].includes(status)) {
    return { label: "In progress", className: "text-primary" }
  }
  if (status === "new") {
    return { label: "Action", className: "text-primary" }
  }
  return { label: humanize(status), className: "text-muted-foreground" }
}

function shortAction(serviceCase: CaseRow): string {
  const action = serviceCase.properties.nextAction ?? serviceCase.properties.title
  if (action.length <= 32) return action
  return serviceCase.properties.title
}

function primaryHeadline(title: string): string {
  const shortened = title
    .replace(/^Boiler\s+\d+\s+entered\s+/i, "")
    .replaceAll("-", " ")
    .replace(/\.$/, "")
  return shortened.charAt(0).toUpperCase() + shortened.slice(1)
}

function primaryImpact(serviceCase: CaseRow): string | undefined {
  if (serviceCase.properties.number === "SC-1038") {
    return "Boiler 2 is locked out. Heating capacity is reduced for the outpatient wing."
  }
  return serviceCase.properties.customerImpact
}

function primaryActionLabel(action: string | undefined): string {
  if (action?.toLowerCase() === "review field diagnosis") return "Review diagnosis"
  return action ?? "Review case"
}

function formatTime(value: string | Date | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value))
}

function sentenceCase(value: string): string {
  const normalized = value.replaceAll("_", " ")
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function casePriority(serviceCase: CaseRow): number {
  const severity = { critical: 40, high: 30, medium: 20, low: 10 }[serviceCase.properties.severity]
  const sla = { breached: 30, at_risk: 20, on_track: 0, met: -10 }[serviceCase.properties.slaStatus]
  return severity + sla
}

function healthPriority(asset: EquipmentRow): number {
  return { offline: 40, unhealthy: 30, watch: 20, healthy: 0 }[asset.properties.health ?? "healthy"]
}

function caseDeadline(serviceCase: CaseRow): string {
  if (["resolved", "closed"].includes(serviceCase.properties.status)) {
    return serviceCase.properties.slaStatus === "met" ? "Commitment met" : "Recovery verified"
  }
  return deadlineLabel(serviceCase.properties.responseDeadline)
}
