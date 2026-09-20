import { GOOGLE_ADS_SCOPE, googleAds } from "@sixb/connector-google"
import { defineConnector } from "@sixb/core"

export const ads = defineConnector(
  "google-ads",
  googleAds({
    auth: {
      serviceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_JSON!,
      scopes: [GOOGLE_ADS_SCOPE],
    },
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
    loginCustomerId: process.env.GOOGLE_ADS_MANAGER_ID!,
  })
)
