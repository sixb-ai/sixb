import { defineConnector } from "@pario/core"
import { createAcmeErpClient } from "../lib/acme-erp"

export const acmeErpConnector = defineConnector("acme-erp", {
  type: "acme-erp",
  connect() {
    return createAcmeErpClient()
  },
})
