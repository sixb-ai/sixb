import type {
  DeployConfigurableWorkerType,
  DeployHttpServiceName,
  DeployServiceName,
  DeploySingletonServiceName,
  DeployWorkerType,
} from "./types"

// Records rather than arrays so that each list is total over its union: a service or worker type
// added to the types does not compile until it is listed here, and validation accepts it.

const SERVICES = {
  api: "http",
  atlas: "http",
  app: "http",
  orchestrator: "singleton",
  scheduler: "singleton",
  rules: "singleton",
  workers: "workers",
} as const satisfies Record<DeployServiceName, "http" | "singleton" | "workers">

/** Whether each worker type's concurrency can be configured. */
const WORKER_TYPES: {
  readonly [Type in DeployWorkerType]: Type extends DeployConfigurableWorkerType ? true : false
} = {
  sync: true,
  action: false,
  agent: true,
  pipeline: true,
  projection: true,
  workflow: true,
}

/** Every service, in the order a deployment lists them. */
export const DEPLOY_SERVICES = Object.keys(SERVICES) as DeployServiceName[]

export const DEPLOY_WORKER_TYPES = Object.keys(WORKER_TYPES) as DeployWorkerType[]

export const DEPLOY_CONFIGURABLE_WORKER_TYPES = DEPLOY_WORKER_TYPES.filter(
  (workerType): workerType is DeployConfigurableWorkerType => WORKER_TYPES[workerType]
)

export function isDeployHttpService(service: DeployServiceName): service is DeployHttpServiceName {
  return SERVICES[service] === "http"
}

export function isDeploySingletonService(
  service: DeployServiceName
): service is DeploySingletonServiceName {
  return SERVICES[service] === "singleton"
}
