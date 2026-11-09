import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

// The canvas a new Cold Chain Priority contract starts with: what is agreed at the kick-off, what
// the campus needs before go-live, and what the first review looks at. Its files sit beside this
// script, in `onboarding-plan/`, as the Agent published them. `demo-artifacts.ts` publishes them
// and attaches the canvas to the contract, whose page shows it.

export const onboardingPlanTitle = "Cold Chain Priority onboarding plan"

/** The contract the plan belongs to, as the business system names it. */
export const onboardingPlanContractId = "contract-camden-priority"

const ONBOARDING_PLAN_DIR = join(import.meta.dir, "onboarding-plan")

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  css: "text/css",
  html: "text/html",
  json: "application/json",
}

/** Every file of the canvas, at its path inside the artifact. */
export async function onboardingPlanFiles(): Promise<
  readonly { readonly path: string; readonly body: Blob; readonly mediaType: string }[]
> {
  const entries = await readdir(ONBOARDING_PLAN_DIR, { recursive: true, withFileTypes: true })

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absolute = join(entry.parentPath, entry.name)
      const extension = entry.name.slice(entry.name.lastIndexOf(".") + 1)

      return {
        path: relative(ONBOARDING_PLAN_DIR, absolute),
        body: Bun.file(absolute),
        mediaType: MEDIA_TYPES[extension] ?? "application/octet-stream",
      }
    })
    .sort((a, b) => a.path.localeCompare(b.path))
}
