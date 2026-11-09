import { ArtifactViewer } from "@sixb/app"
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Shapes } from "lucide-react"
import { useMemo } from "react"
import { Link, useParams } from "react-router-dom"
import { ServiceContract } from "../../../ontology/service-contract"
import {
  Breadcrumb,
  Fact,
  formatCoverageHours,
  formatDate,
  formatMinutes,
  formatMoney,
  QueryState,
  Section,
  StatusBadge,
} from "../../_components/ui"
import { contractTypeLabel } from "../../_lib/contracts"
import type { QueryRow } from "../../_lib/query-types"

function contractQuery(id: string) {
  return objects(ServiceContract)
    .query()
    .where((contract) => contract.p.id.eq(id))
    .expand(ServiceContract.l.customer)
    .expand(ServiceContract.l.coveredFacilities, { limit: 10 })
}

type ContractRow = QueryRow<ReturnType<typeof contractQuery>>

export default function ContractPage() {
  const { id = "" } = useParams<{ id: string }>()
  const query = useMemo(() => contractQuery(id), [id])
  const result = useObjectsQuery(query)
  const contract = result.data?.objects[0]

  return (
    <QueryState
      loading={result.isLoading}
      error={result.isError}
      empty={!contract}
      emptyMessage="Contract not found."
    >
      {contract ? (
        <div className="flex flex-col gap-6">
          <ContractHeader contract={contract} />
          <OnboardingPlan contract={contract} />
        </div>
      ) : null}
    </QueryState>
  )
}

function ContractHeader({ contract }: { contract: ContractRow }) {
  const { properties } = contract
  const customer = contract.links.customer
  const facilities = contract.links.coveredFacilities

  return (
    <header className="flex flex-col gap-4">
      <Breadcrumb to="/contracts" label="Contracts" current={properties.number} />

      <div className="flex items-start justify-between gap-6 max-md:flex-col max-md:gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[40px]">
            {properties.name}
          </h1>
          <p className="text-[16px] text-muted-foreground">
            {customer ? (
              <Link
                to={`/customers/${encodeURIComponent(customer.primaryId)}`}
                className="text-primary hover:underline"
              >
                {customer.properties.name}
              </Link>
            ) : (
              "Customer unavailable"
            )}{" "}
            · {contractTypeLabel(properties.contractType)} ·{" "}
            <span className="tabular-nums">{properties.number}</span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-2">
          <StatusBadge value={properties.status} />
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-9 gap-y-3 pt-1">
        <Fact label="On site within">{formatMinutes(properties.responseTargetMinutes)}</Fact>
        <Fact label="Restored within">{formatMinutes(properties.resolutionTargetMinutes)}</Fact>
        <Fact label="Hours">{formatCoverageHours(properties.coverageHours)}</Fact>
        <Fact label="Approval above">{formatMoney(properties.approvalThreshold)}</Fact>
        <Fact label="Term">
          {formatDate(properties.startsOn)} – {formatDate(properties.endsOn)}
        </Fact>
        {facilities.length > 0 ? (
          <Fact label={facilities.length === 1 ? "Facility" : "Facilities"}>
            {facilities.map((facility) => facility.properties.name).join(", ")}
          </Fact>
        ) : null}
      </dl>
    </header>
  )
}

/**
 * The canvas the contract's start is planned in, live, as the customer reviews it with Northline.
 * A contract without one says so.
 */
function OnboardingPlan({ contract }: { contract: ContractRow }) {
  const plan = contract.properties.onboardingPlan
  const customer = contract.links.customer?.properties.name

  return (
    <Section
      title="Onboarding plan"
      description={
        customer
          ? `Reviewed with ${customer} when the contract starts`
          : "Reviewed with the customer when the contract starts"
      }
    >
      {plan ? (
        <div className="px-3 pb-3 sm:px-4 sm:pb-4">
          <ArtifactViewer artifactId={plan.id} className="h-[30rem] sm:h-[38rem]" />
        </div>
      ) : (
        <div className="flex items-center gap-3 px-6 pt-1 pb-6 text-[14px] text-muted-foreground">
          <Shapes className="size-4 shrink-0" aria-hidden="true" />
          No onboarding plan yet.
        </div>
      )}
    </Section>
  )
}
