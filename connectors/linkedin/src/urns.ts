import { pathId } from "./restli"
import type {
  LinkedinId,
  LinkedinOrganizationUrn,
  LinkedinShareUrn,
  LinkedinSponsoredAccountUrn,
  LinkedinSponsoredCampaignGroupUrn,
  LinkedinSponsoredCampaignUrn,
  LinkedinSponsoredCreativeUrn,
  LinkedinUgcPostUrn,
} from "./types/common"

export function organizationUrn(id: LinkedinId): LinkedinOrganizationUrn {
  return `urn:li:organization:${pathId(id, "organization id")}`
}

export function shareUrn(id: LinkedinId): LinkedinShareUrn {
  return `urn:li:share:${pathId(id, "share id")}`
}

export function ugcPostUrn(id: LinkedinId): LinkedinUgcPostUrn {
  return `urn:li:ugcPost:${pathId(id, "UGC post id")}`
}

export function sponsoredAccountUrn(id: LinkedinId): LinkedinSponsoredAccountUrn {
  return `urn:li:sponsoredAccount:${pathId(id, "ad account id")}`
}

export function sponsoredCampaignGroupUrn(id: LinkedinId): LinkedinSponsoredCampaignGroupUrn {
  return `urn:li:sponsoredCampaignGroup:${pathId(id, "campaign group id")}`
}

export function sponsoredCampaignUrn(id: LinkedinId): LinkedinSponsoredCampaignUrn {
  return `urn:li:sponsoredCampaign:${pathId(id, "campaign id")}`
}

export function sponsoredCreativeUrn(id: LinkedinId): LinkedinSponsoredCreativeUrn {
  return `urn:li:sponsoredCreative:${pathId(id, "creative id")}`
}
