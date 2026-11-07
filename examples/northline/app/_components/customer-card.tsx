import { Link } from "react-router-dom"
import { humanize, Row, Section } from "./ui"

/** Who a record is for: the account, its contact, and the site with its access notes. */
export function CustomerCard({
  customer,
  facility,
}: {
  customer:
    | {
        readonly primaryId: string
        readonly properties: {
          readonly name: string
          readonly serviceTier: string
          readonly primaryContactName?: string
        }
      }
    | null
    | undefined
  facility:
    | {
        readonly properties: {
          readonly name: string
          readonly city?: string
          readonly state?: string
          readonly accessNotes?: string
        }
      }
    | null
    | undefined
}) {
  if (!customer) return null
  return (
    <Section
      title="Customer"
      action={
        <Link
          to={`/customers/${encodeURIComponent(customer.primaryId)}`}
          className="font-medium text-primary hover:underline"
        >
          Open
        </Link>
      }
    >
      <dl className="flex flex-col px-6 pb-4">
        <Row label={customer.properties.name}>{humanize(customer.properties.serviceTier)}</Row>
        {customer.properties.primaryContactName ? (
          <Row label={customer.properties.primaryContactName}>Primary contact</Row>
        ) : null}
        {facility ? (
          <Row label={facility.properties.name}>
            {[facility.properties.city, facility.properties.state].filter(Boolean).join(", ")}
          </Row>
        ) : null}
      </dl>
      {facility?.properties.accessNotes ? (
        <p className="mx-6 mb-5 rounded-[12px] bg-muted px-3.5 py-3 text-[13.5px] leading-5 text-foreground/80">
          {facility.properties.accessNotes}
        </p>
      ) : null}
    </Section>
  )
}
