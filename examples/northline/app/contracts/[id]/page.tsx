import { ArtifactViewer, useCurrentUser, useSharedGuest } from "@sixb/app"
import { issueSharedAccessGrant } from "@sixb/client"
import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Check, Link2, Shapes, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ServiceContract } from "../../../ontology/service-contract"
import { PillButton } from "../../_components/next-step"
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
  // The customer, through a shared link, reads this contract alone: nothing to go back to.
  const guest = useSharedGuest() !== null

  return (
    <header className="flex flex-col gap-4">
      {guest ? null : <Breadcrumb to="/contracts" label="Contracts" current={properties.number} />}

      <div className="flex items-start justify-between gap-6 max-md:flex-col max-md:gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-[34px] leading-[1.06] font-semibold tracking-[-0.03em] text-balance sm:text-[40px]">
            {properties.name}
          </h1>
          <p className="text-[16px] text-muted-foreground">
            {customer && guest ? (
              customer.properties.name
            ) : customer ? (
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
        <div className="flex shrink-0 items-center gap-3 pt-2">
          <StatusBadge value={properties.status} />
          <ShareWithCustomer contractId={contract.primaryId} />
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

/** How long a link to a contract lets the customer in. */
const SHARE_DAYS = 14

/**
 * A link for the customer, who has no account: the contract, and its onboarding plan, which they
 * follow live and comment on as a guest. Members issue it; the customer, on the page it opens,
 * sees no button.
 */
function ShareWithCustomer({ contractId }: { contractId: string }) {
  const user = useCurrentUser()
  const [state, setState] = useState<"idle" | "sharing" | "copied" | "failed">("idle")
  // A link the browser would not copy, shown to copy by hand: it was created all the same.
  const [shown, setShown] = useState<string | null>(null)
  if (!user) return null

  const share = async () => {
    setState("sharing")
    setShown(null)

    let link: string
    try {
      const { data } = await issueSharedAccessGrant({
        body: {
          // shares/contract-onboarding.ts, by its id: the page never bundles the definition.
          definitionId: "contract-onboarding",
          target: { objectTypeId: ServiceContract.id, primaryId: contractId },
          destinationPath: `/contracts/${encodeURIComponent(contractId)}`,
          expiresAt: new Date(Date.now() + SHARE_DAYS * 24 * 60 * 60 * 1000).toISOString(),
        },
        throwOnError: true,
      })
      link = new URL(data.url, window.location.origin).toString()
    } catch {
      setState("failed")
      return
    }

    try {
      await navigator.clipboard.writeText(link)
      setState("copied")
    } catch {
      setState("idle")
      setShown(link)
    }
  }

  return (
    <div className="relative">
      <PillButton
        tone="secondary"
        className="h-8 px-3.5 text-[13px]"
        disabled={state === "sharing"}
        onClick={() => void share()}
        title={`Copies a link that opens this contract for ${SHARE_DAYS} days, without an account`}
      >
        {state === "copied" ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Link2 className="size-3.5" aria-hidden="true" />
        )}
        {state === "copied"
          ? "Link copied"
          : state === "failed"
            ? "Couldn't create a link"
            : "Share with customer"}
      </PillButton>

      {shown ? <SharedLink link={shown} onClose={() => setShown(null)} /> : null}
    </div>
  )
}

/** The link just created, selected, for the member to copy themselves. */
function SharedLink({ link, onClose }: { link: string; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-label="Link for the customer"
      className="absolute top-full right-0 z-20 mt-2 flex w-[min(24rem,calc(100vw-2.5rem))] flex-col gap-2 rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-[0_2px_4px_rgb(0_0_0/0.06),0_18px_40px_-16px_rgb(0_0_0/0.35)]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold">Link for the customer</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <input
        readOnly
        value={link}
        aria-label="Link for the customer"
        onFocus={(event) => event.currentTarget.select()}
        ref={(input) => input?.select()}
        className="h-9 w-full rounded-lg border border-border bg-background px-2.5 font-mono text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <p className="m-0 text-[12px] text-muted-foreground">
        Copy it to send it: it opens this contract for {SHARE_DAYS} days, without an account.
      </p>
    </div>
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
