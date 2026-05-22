import type { S4Runtime } from "@s4/runtime"

export async function s4(runtime: S4Runtime, command: string): Promise<string> {
  const result = await runtime.run(command)
  return result.stdout
}

export async function s4Json<T>(runtime: S4Runtime, command: string): Promise<T> {
  return JSON.parse(await s4(runtime, command)) as T
}

export function lines(stdout: string): string[] {
  return stdout.split("\n").filter(Boolean).sort()
}
