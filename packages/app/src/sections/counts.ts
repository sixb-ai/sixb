import {
  listActionsOptions,
  listObjectTypesOptions,
  listRulesOptions,
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
  const ontology = { enabled: section === "ontology", retry: false, staleTime: 30_000 } as const
  const types = useQuery({ ...listObjectTypesOptions(), ...ontology }).data
  const objects = useQuery({ ...objectCountOptions(), ...ontology }).data
  const actions = useQuery({ ...listActionsOptions(), ...ontology }).data
  const workflows = useQuery({ ...listWorkflowsOptions(), ...ontology }).data
  const rules = useQuery({ ...listRulesOptions(), ...ontology }).data
  if (section !== "ontology") return {}
  const counts: Record<string, number | undefined> = {
    "/ontology/object-types": types?.length,
    "/ontology/objects": objects,
    "/ontology/actions": actions?.length,
    "/ontology/workflows": workflows?.length,
    "/ontology/rules": rules?.length,
  }
  return Object.fromEntries(
    Object.entries(counts).filter((entry): entry is [string, number] => entry[1] !== undefined)
  )
}
