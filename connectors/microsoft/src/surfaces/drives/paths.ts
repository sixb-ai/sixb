import { segment } from "../../validation"

export const drivePath = (driveId: string): string => `drives/${segment(driveId, "driveId")}`
export const itemPath = (driveId: string, itemId: string): string =>
  `${drivePath(driveId)}/${itemId === "root" ? "root" : `items/${segment(itemId, "itemId")}`}`
