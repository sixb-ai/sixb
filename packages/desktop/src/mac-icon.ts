import { run } from "./run"

/**
 * Draws `png` the way macOS draws app icons, into `out`: on Apple's grid, a rounded square of 824
 * pixels with continuous corners in a canvas of 1024, over the soft shadow Apple's own icons have.
 * An icon drawn to its edges otherwise stands larger than every other icon in the Dock.
 */
export async function drawMacIcon(png: string, out: string): Promise<void> {
  await run(
    ["osascript", "-l", "JavaScript", "-e", MAC_ICON_SCRIPT, png, out],
    "Could not draw the macOS icon."
  )
}

// AppKit, through the JavaScript `osascript` runs, which every Mac has. The corner is the curve
// UIKit rounds continuous corners with; with this radius it matches the outline of Apple's Notes
// icon to a few pixels, and the shadow matches its shadow.
const MAC_ICON_SCRIPT = `
ObjC.import("AppKit")
ObjC.import("CoreGraphics")

function run([input, output]) {
  const canvas = 1024
  const body = 824
  const radius = 185.4
  const min = (canvas - body) / 2
  const max = min + body

  // One corner, as offsets in radii from the edge it leaves and the edge it joins.
  const corner = [
    [[1.52866483, 0]],
    [[0.66993427, 0.065496], [1.08849323, 0], [0.86840689, 0.02065986]],
    [[0.63149399, 0.074911]],
    [[0.074911, 0.63149399], [0.37282392, 0.16906933], [0.16906933, 0.37282392]],
    [[0.065496, 0.66993427]],
    [[0, 1.52866483], [0.02065986, 0.86840689], [0, 1.08849323]],
  ]
  const corners = [
    ([u, v]) => $.NSMakePoint(max - u * radius, max - v * radius),
    ([u, v]) => $.NSMakePoint(max - v * radius, min + u * radius),
    ([u, v]) => $.NSMakePoint(min + u * radius, min + v * radius),
    ([u, v]) => $.NSMakePoint(min + v * radius, max - u * radius),
  ]
  const shape = $.NSBezierPath.bezierPath
  shape.moveToPoint(corners[3]([0, 1.52866483]))
  for (const at of corners) {
    for (const [to, c1, c2] of corner) {
      if (c1) shape.curveToPointControlPoint1ControlPoint2(at(to), at(c1), at(c2))
      else shape.lineToPoint(at(to))
    }
  }
  shape.closePath

  const image = $.NSImage.alloc.initWithContentsOfFile(input)
  if (image.isNil()) throw new Error("Cannot read " + input)
  const bitmap = $.NSBitmapImageRep.alloc
    .initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, canvas, canvas, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
    )
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap)
  $.NSGraphicsContext.setCurrentContext(context)
  context.setImageInterpolation($.NSImageInterpolationHigh)

  const shadow = $.NSShadow.alloc.init
  shadow.setShadowOffset($.NSMakeSize(0, -8))
  shadow.setShadowBlurRadius(30)
  shadow.setShadowColor($.NSColor.colorWithWhiteAlpha(0, 0.22))
  shadow.set
  // A layer, so the shadow falls from the clipped icon and not from the clip.
  $.CGContextBeginTransparencyLayer(context.CGContext, null)
  shape.addClip
  image.drawInRectFromRectOperationFraction(
    $.NSMakeRect(min, min, body, body), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1
  )
  $.CGContextEndTransparencyLayer(context.CGContext)
  context.flushGraphics

  const png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary)
  if (!png.writeToFileAtomically(output, true)) throw new Error("Cannot write " + output)
}
`
