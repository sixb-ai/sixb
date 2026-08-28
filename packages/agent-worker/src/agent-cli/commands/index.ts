import { fail } from "../output"
import { actions } from "./actions"
import { files } from "./files"
import { objects } from "./objects"
import { ontology } from "./ontology"
import { runs } from "./runs"
import { context, doctor, project } from "./system"
import { telemetry } from "./telemetry"
import { workflows } from "./workflows"

export async function dispatch(command: string, args: string[]): Promise<void> {
  switch (command) {
    case "doctor":
      return doctor(args)
    case "context":
      return context(args)
    case "project":
      return project(args)
    case "ontology":
      return ontology(args)
    case "objects":
      return objects(args)
    case "telemetry":
      return telemetry(args)
    case "actions":
      return actions(args)
    case "action-runs":
      return runs("action", args)
    case "files":
      return files(args)
    case "workflows":
      return workflows(args)
    case "workflow-runs":
      return runs("workflow", args)
    default:
      fail(`Unknown command '${command}'. Run 'sixb --help'.`)
  }
}
