import type { ApiClient } from "../api-client"
import { fail } from "../output"
import { actions } from "./actions"
import { files } from "./files"
import { objects } from "./objects"
import { ontology } from "./ontology"
import { project } from "./project"
import { runs } from "./runs"
import { telemetry } from "./telemetry"
import { workflows } from "./workflows"

export const INSTANCE_COMMANDS = [
  "project",
  "ontology",
  "objects",
  "telemetry",
  "actions",
  "action-runs",
  "files",
  "workflows",
  "workflow-runs",
] as const

export type InstanceCommand = (typeof INSTANCE_COMMANDS)[number]

export function isInstanceCommand(command: string): command is InstanceCommand {
  return (INSTANCE_COMMANDS as readonly string[]).includes(command)
}

export async function dispatch(
  api: ApiClient,
  command: string,
  args: readonly string[]
): Promise<void> {
  switch (command) {
    case "project":
      return project(api, args)
    case "ontology":
      return ontology(api, args)
    case "objects":
      return objects(api, args)
    case "telemetry":
      return telemetry(api, args)
    case "actions":
      return actions(api, args)
    case "action-runs":
      return runs(api, "action", args)
    case "files":
      return files(api, args)
    case "workflows":
      return workflows(api, args)
    case "workflow-runs":
      return runs(api, "workflow", args)
    default:
      fail(`Unknown command '${command}'. Run 'sixb --help'.`)
  }
}
