import { useObjectsQuery } from "@sixb/client/hooks"
import { objects } from "@sixb/client/query"
import { Campaign } from "../ontology/campaign"

export default function Campaigns() {
  const query = objects(Campaign).query().orderBy(Campaign.p.name, "asc")
  const { data, isPending, error } = useObjectsQuery(query)

  if (isPending) return <p>Loading campaigns…</p>
  if (error) return <p>Could not load campaigns.</p>

  return (
    <ul>
      {data?.objects.map((campaign) => (
        <li key={campaign.primaryId}>{campaign.properties.name}</li>
      ))}
    </ul>
  )
}
