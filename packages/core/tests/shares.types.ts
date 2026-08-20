import { can, defineObjectType, defineShareType, objectRef, prop, type SharesRuntime } from "../src"

const Report = defineObjectType({
  id: "report",
  name: "Report",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const Other = defineObjectType({
  id: "other",
  name: "Other",
  properties: [prop("id", "string", { required: true, primary: true })],
})

const PublishedReportShare = defineShareType({
  id: "published-report",
  target: Report,
  grants: [can.view(Report)],
})

declare const shares: SharesRuntime

void shares.issue({
  type: PublishedReportShare,
  target: objectRef(Report, "report-1"),
  expiresAt: new Date(),
})

void shares.list({
  type: PublishedReportShare,
  target: objectRef(Report, "report-1"),
})

void shares.issue({
  type: "published-report",
  target: objectRef(Other, "other-1"),
  expiresAt: new Date(),
})

void shares.issue({
  type: PublishedReportShare,
  // @ts-expect-error the target must match the selected ShareType
  target: objectRef(Other, "other-1"),
  expiresAt: new Date(),
})

void shares.list({
  type: PublishedReportShare,
  // @ts-expect-error the target must match the selected ShareType
  target: objectRef(Other, "other-1"),
})
