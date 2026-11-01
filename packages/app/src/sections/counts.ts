import {
  listActionsOptions,
  listConnectorsOptions,
  listDatasetsOptions,
  listObjectTypesOptions,
  listPipelinesOptions,
  listProjectionsOptions,
  listRulesOptions,
  listSyncsOptions,
  listWorkflowsOptions,
  objectCountOptions,
} from "@sixb/client/hooks"
import { useQuery } from "@tanstack/react-query"
import type { AppSectionId } from "./catalog"

/**
 * How many of each thing a section's pages hold, by page path, for the counts beside them in its
 * navigation. Read only while that section is open; a count this person may not read is left out.
 */
export function usePageCounts(section: AppSectionId | undefined): Readonly<Record<string, number>> {
  const open = { enabled: section === "console", retry: false, staleTime: 30_000 } as const
  const types = useQuery({ ...listObjectTypesOptions(), ...open }).data
  const objects = useQuery({ ...objectCountOptions(), ...open }).data
  const actions = useQuery({ ...listActionsOptions(), ...open }).data
  const workflows = useQuery({ ...listWorkflowsOptions(), ...open }).data
  const rules = useQuery({ ...listRulesOptions(), ...open }).data
  const connectors = useQuery({ ...listConnectorsOptions(), ...open }).data
  const syncs = useQuery({ ...listSyncsOptions(), ...open }).data
  const datasets = useQuery({ ...listDatasetsOptions(), ...open }).data
  const pipelines = useQuery({ ...listPipelinesOptions(), ...open }).data
  const projections = useQuery({ ...listProjectionsOptions(), ...open }).data
  if (section !== "console") return {}
  const counts: Record<string, number | undefined> = {
    "/console/connectors": connectors?.length,
    "/console/syncs": syncs?.length,
    "/console/datasets": datasets?.length,
    "/console/pipelines": pipelines?.length,
    "/console/projections":
      projections &&
      projections.objectProjections.length +
        projections.linkProjections.length +
        projections.telemetryProjections.length,
    "/console/object-types": types?.length,
    "/console/objects": objects,
    "/console/actions": actions?.length,
    "/console/workflows": workflows?.length,
    "/console/rules": rules?.length,
  }
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => entry[1] !== undefined)
  )
}
