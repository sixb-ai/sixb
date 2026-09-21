/** Internal worker entry point; it does not expose the host context or domain SDK. */
export interface VectorIndexingRuntime {
  process(id: string, attempt: number, signal: AbortSignal): Promise<void>
}

// Associates each host with its service. Durable work lives in ontology storage, not this map.
const runtimes = new WeakMap<object, VectorIndexingRuntime>()

export function registerVectorIndexingRuntime(host: object, runtime: VectorIndexingRuntime): void {
  runtimes.set(host, runtime)
}

export function getVectorIndexingRuntime(host: object): VectorIndexingRuntime {
  const runtime = runtimes.get(host)
  if (!runtime) throw new Error("[Sixb] Vector indexing requires a configured Sixb host.")
  return runtime
}
