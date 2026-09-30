import { agent, applications, can, defineRole, every } from "@sixb/core"
import { operators } from "../groups/operators"

/** Operators see and run everything. Only a deployment signs people in; `sixb dev` does not. */
export const operatorAccess = defineRole("operator-access", {
  grantedTo: [operators],
  grants: [
    can.access([applications.atlas, applications.app]),
    can.view(every.object()),
    can.view(every.dataset()),
    can.edit(every.object()),
    can.append(every.object()),
    can.apply(every.action()),
    can.run(every.workflow()),
    can.run(every.sync()),
    can.run(every.pipeline()),
    can.run(agent),
    can.observe("logs"),
    can.observe(agent.usage),
    can.manage(agent.usage),
  ],
})
