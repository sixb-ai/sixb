/**
 * The launch screen's icon size in CSS pixels. The production loading shell and the iOS launch
 * image draw the app's icon at this size in the middle of the screen, so one hands over to the
 * other without a jump.
 */
export const LAUNCH_ICON_SIZE = 72

/** Whether the page runs as the app added to the Home Screen rather than in a browser tab. */
export function isInstalledApp(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}
