import { defineDeploy } from "@sixb/core/deploy"
import { SshTarget } from "@sixb/deploy-ssh"

// The server and domain come from the environment, so no address lands in this repository.
const host = process.env.NORTHLINE_DEPLOY_HOST
const domain = process.env.NORTHLINE_DEPLOY_DOMAIN
if (!host || !domain) {
  throw new Error(
    "[Northline] Set NORTHLINE_DEPLOY_HOST and NORTHLINE_DEPLOY_DOMAIN to deploy Northline."
  )
}

export default defineDeploy({
  name: "northline",
  domain,
  target: new SshTarget({ host }),
})
