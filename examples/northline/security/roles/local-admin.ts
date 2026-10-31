import { agent, can, defineRole, every, project } from "@sixb/core"
import { localAdmins } from "../groups/local-admins"

// Local only: everything a signed-in admin needs to use the agent, the Console and Settings.
export const localAdmin = defineRole("local-admin", {
  grantedTo: [localAdmins],
  grants: [
    can.run(agent),
    can.view(every.object()),
    can.edit(every.object()),
    can.append(every.object()),
    can.apply(every.action()),
    can.run(every.workflow()),
    can.run(every.sync()),
    can.run(every.pipeline()),
    can.view(every.dataset()),
    can.manage(every.connector()),
    can.view(project.users),
    can.observe(project.logs),
    can.observe(project.activity),
    can.observe(project.console),
    can.observe(agent.usage),
    can.manage(agent.usage),
    can.observe(agent.threads),
  ],
})
