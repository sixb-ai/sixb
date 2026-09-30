import type { DeployConfigurableWorkerType, DeployWorkerType } from "@sixb/core/deploy"
import type { ConfigurableWorkerType, WorkerType } from "../src/lib/worker-registry"

type Expect<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/**
 * `sixb.deploy.ts` names the same worker types `sixb worker-group` runs, and configures the same
 * ones. Reproduce: add a worker type to `WORKER_TYPES` in worker-registry.ts only, or make one
 * configurable on one side only, and `typecheck:tests` fails here.
 */
type _deployNamesEveryWorkerType = Expect<Equal<DeployWorkerType, WorkerType>>
type _deployConfiguresTheSameWorkers = Expect<
  Equal<DeployConfigurableWorkerType, ConfigurableWorkerType>
>
