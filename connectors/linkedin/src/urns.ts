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
  const value = String(id)
  const prefix = "urn:li:sponsoredCreative:"

  if (value.startsWith(prefix)) {
    pathId(value.slice(prefix.length), "creative id")
    return value as LinkedinSponsoredCreativeUrn
  }
  if (value.startsWith("urn:li:")) {
    throw new Error(
      "[SixbLinkedin] creative id must be a positive numeric ID or a sponsored creative URN."
    )
  }
  return `${prefix}${pathId(value, "creative id")}`
}
