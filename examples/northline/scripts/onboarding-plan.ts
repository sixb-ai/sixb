import { join } from "node:path"
import { folderFiles } from "./folder-files"

// The canvas a new Cold Chain Priority contract starts with: what is agreed at the kick-off, what
// the campus needs before go-live, and what the first review looks at. Its files sit beside this
// script, in `onboarding-plan/`, as the Agent published them. `demo-artifacts.ts` publishes them
// and attaches the canvas to the contract, whose page shows it.

export const onboardingPlanTitle = "Cold Chain Priority onboarding plan"

/** The contract the plan belongs to, as the business system names it. */
export const onboardingPlanContractId = "contract-camden-priority"

/** Every file of the canvas, at its path inside the artifact. */
export const onboardingPlanFiles = () => folderFiles(join(import.meta.dir, "onboarding-plan"))
