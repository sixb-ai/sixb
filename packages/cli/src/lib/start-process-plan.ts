import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { createCustomApp } from "@pario/app"
import { compileRoutesWithDiagnostics } from "@pario/orchestrator"
import { resolveBrowserTopology } from "./browser-topology"
import type { LoadedPario } from "./loadPario"
import { builtAppOutdir, loadProductionPario } from "./production"
import { stopParioProviders } from "./runtime"
import { resolveRegisteredWorkerTypes } from "./worker-registry"

export interface StartOptions {
  entry?: string
  port?: string
  host?: string
  apiPort?: string
  apiHost?: string
  apiPublicOrigin?: string
  atlasPublicOrigin?: string
  sentinelPublicOrigin?: string
  appPublicOrigin?: string
}

export interface StartProcessSpec {
  readonly role: string
  readonly args: readonly string[]
}

export interface StartProcessPlan {
  readonly projectId: string
  readonly entry: string
  readonly specs: readonly StartProcessSpec[]
  readonly warnings: readonly string[]
}

export async function resolveStartProcessPlan(
  options: StartOptions = {}
): Promise<StartProcessPlan> {
  const loaded = await loadProductionPario({ entry: options.entry })

  try {
    const projectRoot = loaded.projectRoot
    const appOutdir = builtAppOutdir(loaded.buildOutdir)
    const hasBuiltCustomApp = await stat(resolve(appOutdir, "index.html"))
      .then(() => true)
      .catch(() => false)
    const customApp = await createCustomApp({ rootDir: projectRoot })
    const hasCustomAppSource = await customApp.hasRoutes()
    const topology = resolveBrowserTopology({
      mode: "production",
      host: options.host ?? "0.0.0.0",
      apiHost: options.apiHost,
      port: options.port,
      apiPort: options.apiPort,
      apiPublicOrigin: options.apiPublicOrigin,
      atlasPublicOrigin: options.atlasPublicOrigin,
      sentinelPublicOrigin: options.sentinelPublicOrigin,
      appPublicOrigin: options.appPublicOrigin,
      includeCustomApp: hasBuiltCustomApp,
    })

    return {
      projectId: loaded.pario.id,
      entry: loaded.entry,
      specs: buildStartProcessSpecs({
        entry: loaded.entry,
        pario: loaded.pario,
        host: topology.host,
        apiHost: topology.apiHost,
        atlasPort: topology.atlasPort,
        sentinelPort: topology.sentinelPort,
        appPort: topology.appPort,
        apiPort: topology.apiPort,
        apiPublicOrigin: topology.apiPublicOrigin,
        atlasPublicOrigin: topology.atlasPublicOrigin,
        sentinelPublicOrigin: topology.sentinelPublicOrigin,
        appPublicOrigin: topology.appPublicOrigin,
        hasBuiltCustomApp,
      }),
      warnings: resolveStartWarnings({
        pario: loaded.pario,
        hasBuiltCustomApp,
        hasCustomAppSource,
      }),
    }
  } finally {
    await stopParioProviders(loaded.pario)
  }
}

function buildStartProcessSpecs(input: {
  readonly entry: string
  readonly pario: LoadedPario
  readonly host: string
  readonly apiHost: string
  readonly atlasPort: number
  readonly sentinelPort: number
  readonly appPort: number
  readonly apiPort: number
  readonly apiPublicOrigin: string
  readonly atlasPublicOrigin: string | null
  readonly sentinelPublicOrigin: string | null
  readonly appPublicOrigin: string | null
  readonly hasBuiltCustomApp: boolean
}): readonly StartProcessSpec[] {
  const specs: StartProcessSpec[] = [
    {
      role: "api",
      args: [
        "api",
        "--entry",
        input.entry,
        "--host",
        input.host,
        "--api-host",
        input.apiHost,
        "--api-port",
        String(input.apiPort),
        "--api-public-origin",
        input.apiPublicOrigin,
        "--atlas-public-origin",
        requireOrigin(input.atlasPublicOrigin, "Atlas"),
        "--sentinel-public-origin",
        requireOrigin(input.sentinelPublicOrigin, "Sentinel"),
        ...(input.appPublicOrigin ? ["--app-public-origin", input.appPublicOrigin] : []),
      ],
    },
    {
      role: "atlas",
      args: [
        "atlas",
        "--entry",
        input.entry,
        "--host",
        input.host,
        "--port",
        String(input.atlasPort),
        "--api-public-origin",
        input.apiPublicOrigin,
        "--atlas-public-origin",
        requireOrigin(input.atlasPublicOrigin, "Atlas"),
      ],
    },
    {
      role: "sentinel",
      args: [
        "sentinel",
        "--entry",
        input.entry,
        "--host",
        input.host,
        "--port",
        String(input.sentinelPort),
        "--api-public-origin",
        input.apiPublicOrigin,
        "--sentinel-public-origin",
        requireOrigin(input.sentinelPublicOrigin, "Sentinel"),
      ],
    },
  ]

  if (input.hasBuiltCustomApp && input.appPublicOrigin) {
    specs.push({
      role: "app",
      args: [
        "app",
        "--entry",
        input.entry,
        "--host",
        input.host,
        "--port",
        String(input.appPort),
        "--api-public-origin",
        input.apiPublicOrigin,
        "--app-public-origin",
        input.appPublicOrigin,
      ],
    })
  }

  if (hasOrchestratorRoutes(input.pario)) {
    specs.push({ role: "orchestrator", args: ["orchestrator", "--entry", input.entry] })
  }

  if (input.pario.getScheduleDefinitions().length > 0) {
    specs.push({ role: "scheduler", args: ["scheduler", "--entry", input.entry] })
  }

  if (input.pario.getRuleDefinitions().length > 0) {
    specs.push({ role: "rules", args: ["rules", "--entry", input.entry] })
  }

  if (input.pario.getFunctionDefinitions().length > 0) {
    specs.push({ role: "functions", args: ["functions", "--entry", input.entry] })
  }

  for (const workerType of resolveRegisteredWorkerTypes(input.pario)) {
    specs.push({
      role: `worker:${workerType}`,
      args: ["worker", workerType, "--entry", input.entry],
    })
  }

  return specs
}

function resolveStartWarnings(input: {
  readonly pario: LoadedPario
  readonly hasBuiltCustomApp: boolean
  readonly hasCustomAppSource: boolean
}): readonly string[] {
  const warnings: string[] = []
  const { diagnostics } = compileRoutesWithDiagnostics({
    syncs: input.pario.getSyncDefinitions(),
    pipelines: input.pario.getPipelineDefinitions(),
    projections: [...input.pario.getObjectProjections(), ...input.pario.getLinkProjections()],
    workflows: input.pario.getWorkflowDefinitions(),
  })

  warnings.push(...diagnostics.map(formatRouteDiagnosticWarning))

  if (input.hasCustomAppSource && !input.hasBuiltCustomApp) {
    warnings.push(
      "Custom app source found, but no production build exists at .pario/dist/app. Run `pario build` first."
    )
  }

  return warnings
}

function formatRouteDiagnosticWarning(
  diagnostic: ReturnType<typeof compileRoutesWithDiagnostics>["diagnostics"][number]
): string {
  switch (diagnostic.type) {
    case "workflow.schedule.input-required":
      return `[Pario] Workflow '${diagnostic.workflowId}' is scheduled but has non-empty input (${diagnostic.inputFields.join(", ")}); it was not auto-routed.`
  }
}

function hasOrchestratorRoutes(pario: LoadedPario): boolean {
  const { routes } = compileRoutesWithDiagnostics({
    syncs: pario.getSyncDefinitions(),
    pipelines: pario.getPipelineDefinitions(),
    projections: [...pario.getObjectProjections(), ...pario.getLinkProjections()],
    workflows: pario.getWorkflowDefinitions(),
  })
  return routes.size > 0
}

function requireOrigin(origin: string | null, role: string): string {
  if (!origin) {
    throw new Error(`[ParioCLI] ${role} public origin was not resolved.`)
  }

  return origin
}
