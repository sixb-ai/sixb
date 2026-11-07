import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { cn } from "@sixb/ui/lib/utils"
import { Check, ChevronRight, ClipboardCheck, Radio, ShieldCheck, Wrench } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { CustomerAccount } from "../../../ontology/customer-account"
import { Equipment } from "../../../ontology/equipment"
import { Facility } from "../../../ontology/facility"
import { Quote } from "../../../ontology/quote"
import { ServiceCase } from "../../../ontology/service-case"
import { ServiceContract } from "../../../ontology/service-contract"
import { ServiceVisit } from "../../../ontology/service-visit"
import { WorkOrder } from "../../../ontology/work-order"
import { EquipmentPicture } from "../../_components/equipment-picture"
import { Timeline, type TimelineEntry } from "../../_components/timeline"
import {
  CaseClockText,
  casePriority,
  Fact,
  formatCoverageHours,
  formatDate,
  formatMinutes,
  formatMoney,
  humanize,
  initials,
  isCaseAtRisk,
  QueryState,
  Section,
  StatusBadge,
  StatusIndicator,
} from "../../_components/ui"
import type { QueryRow } from "../../_lib/query-types"
import { quotePath } from "../../_lib/quotes"

/** A customer and the records that belong to it, each followed from the customer by the server. */
function customerQueries(id: string) {
  const customer = objects(CustomerAccount)
    .query()
    .where((account) => account.p.id.eq(id))
  const facilities = customer.traverse(Facility.l.customer, { direction: "incoming" })
  const cases = customer.traverse(ServiceCase.l.customer, { direction: "incoming" })
  return {
    customer,
    facilities: facilities.limit(100),
    equipment: facilities
      .traverse(Equipment.l.facility, { direction: "incoming" })
      .expand(Equipment.l.facility)
      .limit(200),
    cases: cases.expand(ServiceCase.l.facility).expand(ServiceCase.l.equipment).limit(100),
    contracts: customer
      .traverse(ServiceContract.l.customer, { direction: "incoming" })
      .expand(ServiceContract.l.coveredFacilities, { limit: 10 })
      .limit(100),
    visits: cases
      .traverse(WorkOrder.l.serviceCase, { direction: "incoming" })
      .traverse(ServiceVisit.l.workOrder, { direction: "incoming" })
      .expand(ServiceVisit.l.technician)
      .expand(ServiceVisit.l.workOrder, (workOrder) => workOrder.expand(WorkOrder.l.serviceCase))
      .limit(100),
    quotes: customer.traverse(Quote.l.customer, { direction: "incoming" }).limit(100),
  }
}

type CustomerQueries = ReturnType<typeof customerQueries>
type FacilityRow = QueryRow<CustomerQueries["facilities"]>
type EquipmentRow = QueryRow<CustomerQueries["equipment"]>
type CaseRow = QueryRow<CustomerQueries["cases"]>
type ContractRow = QueryRow<CustomerQueries["contracts"]>
type VisitRow = QueryRow<CustomerQueries["visits"]>
type QuoteRow = QueryRow<CustomerQueries["quotes"]>

const contractTypes: Record<string, string> = {
  full_service: "Full service",
  priority_care: "PriorityCare",
  preventive: "Preventive",
}

export default function CustomerDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const queries = useMemo(() => customerQueries(id), [id])
  const customerResult = useObjectsQuery(queries.customer)
  const facilitiesResult = useObjectsQuery(queries.facilities)
  const equipmentResult = useObjectsQuery(queries.equipment)
  const casesResult = useObjectsQuery(queries.cases)
  const contractsResult = useObjectsQuery(queries.contracts)
  const visitsResult = useObjectsQuery(queries.visits)
  const quotesResult = useObjectsQuery(queries.quotes)

  const customer = customerResult.data?.objects[0]
  const facilities = facilitiesResult.data?.objects ?? []
  const equipment = equipmentResult.data?.objects ?? []
  const cases = casesResult.data?.objects ?? []
  const activeCases = cases
    .filter((serviceCase) => !["closed", "cancelled"].includes(serviceCase.properties.status))
    .sort((left, right) => casePriority(right.properties) - casePriority(left.properties))
  const contracts = [...(contractsResult.data?.objects ?? [])].sort(
    (left, right) => Number(isCurrent(right)) - Number(isCurrent(left))
  )
  const visits = visitsResult.data?.objects ?? []
  const quotes = quotesResult.data?.objects ?? []
  const slaRisks = activeCases.filter((serviceCase) => isCaseAtRisk(serviceCase.properties)).length
  const loading =
    customerResult.isLoading ||
    facilitiesResult.isLoading ||
    equipmentResult.isLoading ||
    casesResult.isLoading ||
    contractsResult.isLoading
  const error =
    customerResult.isError ||
    facilitiesResult.isError ||
    equipmentResult.isError ||
    casesResult.isError ||
    contractsResult.isError

  return (
    <QueryState
      loading={loading}
      error={error}
      empty={!customer}
      emptyMessage="Customer account not found."
    >
      {customer ? (
        <div className="flex flex-col gap-6">
          <header className="flex flex-col gap-4">
            <nav className="flex items-center gap-2 text-[14px] text-muted-foreground">
              <Link to="/customers" className="text-primary hover:underline">
                Customers
              </Link>
              <ChevronRight className="size-3.5" />
              <span className="truncate">{customer.properties.name}</span>
            </nav>
            <div className="flex items-start justify-between gap-6 max-md:flex-col max-md:gap-3">
              <div className="flex min-w-0 items-center gap-5">
                <span
                  className="flex size-16 shrink-0 items-center justify-center rounded-full bg-[var(--northline-tint)] text-[22px] font-semibold tracking-[-0.02em] text-primary sm:size-[72px] sm:text-[24px]"
                  aria-hidden="true"
                >
                  {initials(customer.properties.name)}
                </span>
                <div className="flex min-w-0 flex-col gap-1.5">
                  <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[40px]">
                    {customer.properties.name}
                  </h1>
                  <p className="text-[16px] text-muted-foreground">
                    {humanize(customer.properties.serviceTier)} customer · {facilities.length}{" "}
                    {pluralize("facility", "facilities", facilities.length)} · {equipment.length}{" "}
                    connected {pluralize("unit", "units", equipment.length)}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 pt-2">
                <StatusBadge value={customer.properties.status} />
              </div>
            </div>
            <dl className="flex flex-wrap gap-x-9 gap-y-3 pt-1">
              <Fact label="Service tier">{humanize(customer.properties.serviceTier)}</Fact>
              <Fact label="Primary contact">
                {customer.properties.primaryContactName ?? "Not assigned"}
              </Fact>
              {customer.properties.primaryContactEmail ? (
                <Fact label="Email">
                  <a
                    href={`mailto:${customer.properties.primaryContactEmail}`}
                    className="text-primary hover:underline"
                  >
                    {customer.properties.primaryContactEmail}
                  </a>
                </Fact>
              ) : null}
              <Fact label="Open cases">{activeCases.length}</Fact>
              <Fact label="At risk">
                <span className={cn(slaRisks > 0 && "text-[color:var(--warning)]")}>
                  {slaRisks}
                </span>
              </Fact>
            </dl>
          </header>

          <div className="flex flex-wrap items-start gap-5">
            <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-5">
              <Section
                title="Open cases"
                description="Customer impact and response commitments, most urgent first"
              >
                {activeCases.length === 0 ? (
                  <Empty>No open service cases.</Empty>
                ) : (
                  <ul className="px-6 pb-2">
                    {activeCases.map((serviceCase) => (
                      <OpenCaseRow key={serviceCase.primaryId} serviceCase={serviceCase} />
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title={`Everything with ${customer.properties.name}`}
                description="Service cases, field visits and quotes across every facility"
              >
                <Timeline entries={timelineEntries(cases, visits, quotes)} limit={20} />
              </Section>
            </div>

            <aside className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
              <ContractsCard contracts={contracts} />
              <FacilitiesCard facilities={facilities} equipment={equipment} />
            </aside>
          </div>
        </div>
      ) : null}
    </QueryState>
  )
}

function OpenCaseRow({ serviceCase }: { serviceCase: CaseRow }) {
  const unit = serviceCase.links.equipment
  return (
    <li className="border-t border-border/70 first:border-t-0">
      <Link
        to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}
        className="group grid grid-cols-[3rem_minmax(0,1fr)_auto_1rem] items-center gap-4 py-3.5 focus-visible:outline-none"
      >
        <UnitThumb
          name={unit?.properties.name}
          type={unit?.properties.equipmentType}
          className="size-12 rounded-[12px]"
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-[13px] font-semibold text-muted-foreground tabular-nums">
              {serviceCase.properties.number}
            </span>
            <span className="truncate text-[15.5px] font-semibold tracking-[-0.01em] group-hover:text-primary group-focus-visible:text-primary">
              {serviceCase.properties.title}
            </span>
          </span>
          <span className="truncate text-[13.5px] text-muted-foreground">
            {[
              serviceCase.links.facility?.properties.name,
              unit?.properties.name,
              serviceCase.properties.ownerName,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1.5">
          <StatusBadge value={serviceCase.properties.status} />
          <CaseClockText
            serviceCase={serviceCase.properties}
            className="text-[13px] font-medium whitespace-nowrap text-foreground/70"
          />
        </span>
        <ChevronRight className="size-4 text-muted-foreground/50 group-hover:text-muted-foreground" />
      </Link>
    </li>
  )
}

function ContractsCard({ contracts }: { contracts: readonly ContractRow[] }) {
  return (
    <Section
      title={contracts.length === 1 ? "Contract" : "Contracts"}
      action={
        <Link to="/contracts" className="font-medium text-primary hover:underline">
          All contracts
        </Link>
      }
    >
      {contracts.length === 0 ? (
        <Empty>No contract covers this account.</Empty>
      ) : (
        <div className="flex flex-col px-6 pb-4">
          {contracts.map((contract) => {
            const { properties } = contract
            return (
              <div
                key={contract.primaryId}
                className="flex flex-col gap-3 border-t border-border/70 py-3.5 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-[15px] font-semibold">{properties.name}</span>
                    <span className="text-[13px] text-muted-foreground tabular-nums">
                      {properties.number} ·{" "}
                      {contractTypes[properties.contractType] ?? properties.contractType}
                    </span>
                  </span>
                  <StatusBadge value={properties.status} />
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <Fact label="Response">{formatMinutes(properties.responseTargetMinutes)}</Fact>
                  <Fact label="Hours">{formatCoverageHours(properties.coverageHours)}</Fact>
                  <Fact label="Approval above">{formatMoney(properties.approvalThreshold)}</Fact>
                  <Fact label="Renews">{formatDate(properties.endsOn)}</Fact>
                </dl>
                <p className="text-[13px] text-muted-foreground">
                  Labor {properties.includedLabor ? "included" : "excluded"} · major parts{" "}
                  {properties.majorComponentsExcluded ? "excluded" : "included"}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function FacilitiesCard({
  facilities,
  equipment,
}: {
  facilities: readonly FacilityRow[]
  equipment: readonly EquipmentRow[]
}) {
  return (
    <Section
      title="Facilities"
      description={`${facilities.length} ${pluralize("site", "sites", facilities.length)} · ${equipment.length} ${pluralize("unit", "units", equipment.length)}`}
    >
      {facilities.length === 0 ? (
        <Empty>No facilities connected to this account.</Empty>
      ) : (
        <div className="flex flex-col px-6 pb-3">
          {facilities.map((facility) => {
            const units = equipment.filter(
              (asset) => asset.links.facility?.primaryId === facility.primaryId
            )
            const { properties } = facility
            return (
              <div
                key={facility.primaryId}
                className="border-t border-border/70 py-4 first:border-t-0 first:pt-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[15px] font-semibold">{properties.name}</span>
                    <span className="text-[13px] leading-5 text-muted-foreground">
                      {properties.addressLine}, {properties.city}, {properties.state}{" "}
                      {properties.postalCode}
                    </span>
                    <span className="text-[13px] text-muted-foreground">
                      {humanize(properties.territory)}
                      {properties.status !== "operational"
                        ? ` · ${humanize(properties.status)}`
                        : ""}
                    </span>
                  </span>
                  {properties.criticality === "critical" ? (
                    <StatusBadge value="critical" label="Critical site" />
                  ) : null}
                </div>
                {units.length > 0 ? (
                  <ul className="mt-3 flex flex-col">
                    {units.map((asset) => (
                      <li key={asset.primaryId}>
                        <Link
                          to={`/equipment/${encodeURIComponent(asset.primaryId)}`}
                          className="group -mx-2 flex items-center gap-3 rounded-[10px] px-2 py-1.5 transition-colors hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:hover:bg-white/[0.05]"
                        >
                          <UnitThumb
                            name={asset.properties.name}
                            type={asset.properties.equipmentType}
                            className="size-9 rounded-[9px]"
                          />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[14px] font-medium group-hover:text-primary">
                              {asset.properties.name}
                            </span>
                            <span className="truncate text-[12.5px] text-muted-foreground">
                              {[asset.properties.manufacturer, asset.properties.model]
                                .filter(Boolean)
                                .join(" ")}
                            </span>
                          </span>
                          <StatusIndicator value={asset.properties.health} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}

function UnitThumb({
  name,
  type,
  className,
}: {
  name: string | undefined
  type: string | undefined
  className: string
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden bg-muted",
        className
      )}
    >
      <EquipmentPicture
        name={name}
        type={type}
        inset="p-1"
        iconClassName="size-[45%] text-foreground/55"
      />
    </span>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-6 pt-1 pb-6 text-[14px] text-muted-foreground">{children}</p>
}

function timelineEntries(
  cases: readonly CaseRow[],
  visits: readonly VisitRow[],
  quotes: readonly QuoteRow[]
): TimelineEntry[] {
  return [
    ...cases.flatMap((serviceCase) => {
      const { properties } = serviceCase
      const entries: TimelineEntry[] = [
        {
          id: `${serviceCase.primaryId}-opened`,
          at: properties.detectedAt,
          icon: Radio,
          title: `${properties.number} opened`,
          detail: properties.title,
          source: serviceCase.links.facility?.properties.name ?? "Northline Operations",
          emphasis: properties.severity === "critical",
          action: (
            <TimelineLink to={`/service-cases/${encodeURIComponent(serviceCase.primaryId)}`}>
              Open case
            </TimelineLink>
          ),
        },
      ]
      if (properties.resolvedAt) {
        entries.push({
          id: `${serviceCase.primaryId}-resolved`,
          at: properties.resolvedAt,
          icon: Check,
          title: `${properties.number} resolved`,
          detail: properties.resolutionSummary,
          source: "Northline Operations",
        })
      }
      if (properties.closedAt) {
        entries.push({
          id: `${serviceCase.primaryId}-closed`,
          at: properties.closedAt,
          icon: Check,
          title: `${properties.number} closed`,
          source: "Northline Operations",
        })
      }
      return entries
    }),
    ...visits.flatMap((visit) => {
      const { properties } = visit
      const caseNumber = visit.links.workOrder?.links.serviceCase?.properties.number
      const entries: TimelineEntry[] = [
        {
          id: `${visit.primaryId}-start`,
          at: properties.startedAt ?? properties.scheduledStart,
          icon: Wrench,
          title: `${properties.number} ${properties.startedAt ? "started" : "scheduled"}`,
          detail: [visit.links.technician?.properties.name, caseNumber].filter(Boolean).join(" · "),
          source: "Field service",
        },
      ]
      if (properties.completedAt) {
        entries.push({
          id: `${visit.primaryId}-complete`,
          at: properties.completedAt,
          icon: ClipboardCheck,
          title: `${properties.number} completed`,
          detail: properties.workPerformed,
          source: "Field service",
          status: properties.completionDisposition,
        })
      }
      return entries
    }),
    ...quotes.map((quote) => ({
      id: quote.primaryId,
      at: quote.properties.decisionAt ?? quote.properties.sourceUpdatedAt,
      icon: ShieldCheck,
      title: `${quote.properties.number} · ${formatMoney(quote.properties.amount)}`,
      detail: quote.properties.scope,
      source: "Business system",
      status: quote.properties.status,
      action: <TimelineLink to={quotePath(quote.primaryId)}>Open quote</TimelineLink>,
    })),
  ]
}

function TimelineLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="w-fit text-[13px] font-medium text-primary hover:underline">
      {children}
    </Link>
  )
}

function isCurrent(contract: ContractRow): boolean {
  return ["active", "expiring"].includes(contract.properties.status)
}

function pluralize(singular: string, plural: string, count: number): string {
  return count === 1 ? singular : plural
}
