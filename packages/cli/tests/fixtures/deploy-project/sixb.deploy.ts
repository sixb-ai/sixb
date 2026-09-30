import { defineDeploy } from "@sixb/core/deploy"
import { SshTarget } from "@sixb/deploy-ssh"

export default defineDeploy({
  name: "northline",
  domain: "example.com",
  target: new SshTarget({ host: "203.0.113.10", ports: { api: 3012 } }),
  services: {
    app: { domain: "ops.example.com" },
    scheduler: false,
  },
})
