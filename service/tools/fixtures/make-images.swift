// Draws the synthetic test frames in fixtures/images at the passthrough camera's 1280 x 960:
// a desert-trip photo lying on a desk, and a page of Korean study notes with one deliberate
// learner mistake ("갔어요" written as "갓어요"). Synthetic, so they can live in the repository.
//
// Usage: swift tools/fixtures/make-images.swift <output directory>

import AppKit

let width = 1280.0
let height = 960.0
let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "fixtures/images"

func render(_ name: String, _ draw: () -> Void) {
    // An explicit bitmap, so a Retina display does not double the pixels.
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(width), pixelsHigh: Int(height),
                                        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
        fatalError("Could not create a bitmap for \(name)")
    }
    bitmap.size = NSSize(width: width, height: height)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else {
        fatalError("Could not encode \(name)")
    }
    try! jpeg.write(to: URL(fileURLWithPath: "\(output)/\(name)"))
    print("Wrote \(output)/\(name)")
}

func fill(_ color: NSColor, _ rect: NSRect) {
    color.setFill()
    rect.fill()
}

// AppKit's origin is bottom-left; these helpers take top-left coordinates like the frames do.
func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> NSRect {
    NSRect(x: x, y: height - y - h, width: w, height: h)
}

func point(_ x: Double, _ y: Double) -> NSPoint { NSPoint(x: x, y: height - y) }

func text(_ string: String, _ x: Double, _ y: Double, _ font: NSFont, _ color: NSColor) {
    let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    let size = (string as NSString).size(withAttributes: attributes)
    (string as NSString).draw(at: NSPoint(x: x, y: height - y - size.height), withAttributes: attributes)
}

func camel(_ x: Double, _ y: Double, _ scale: Double) {
    let color = NSColor(calibratedRed: 0.24, green: 0.16, blue: 0.10, alpha: 1)
    color.setFill()
    NSBezierPath(ovalIn: rect(x, y, 70 * scale, 30 * scale)).fill()
    NSBezierPath(ovalIn: rect(x + 18 * scale, y - 16 * scale, 30 * scale, 26 * scale)).fill()
    let neck = NSBezierPath()
    neck.move(to: point(x + 60 * scale, y + 10 * scale))
    neck.line(to: point(x + 82 * scale, y - 22 * scale))
    neck.line(to: point(x + 92 * scale, y - 18 * scale))
    neck.line(to: point(x + 70 * scale, y + 16 * scale))
    neck.close()
    neck.fill()
    NSBezierPath(ovalIn: rect(x + 80 * scale, y - 30 * scale, 22 * scale, 12 * scale)).fill()
    for leg in [8.0, 20.0, 48.0, 60.0] {
        rect(x + leg * scale, y + 24 * scale, 5 * scale, 34 * scale).fill()
    }
}

render("desert-photo.jpg") {
    // The desk and the room behind it.
    fill(NSColor(calibratedRed: 0.36, green: 0.27, blue: 0.20, alpha: 1), rect(0, 0, width, height))
    fill(NSColor(calibratedRed: 0.80, green: 0.79, blue: 0.76, alpha: 1), rect(0, 0, width, 230))
    // The printed photo, with a white border, a little left of center.
    let x = 300.0, y = 300.0, w = 600.0, h = 420.0
    fill(.white, rect(x - 16, y - 16, w + 32, h + 32))
    let sky = NSGradient(starting: NSColor(calibratedRed: 0.98, green: 0.62, blue: 0.30, alpha: 1),
                         ending: NSColor(calibratedRed: 0.32, green: 0.50, blue: 0.82, alpha: 1))!
    sky.draw(in: rect(x, y, w, h * 0.55), angle: 90)
    NSColor(calibratedRed: 1, green: 0.85, blue: 0.45, alpha: 1).setFill()
    NSBezierPath(ovalIn: rect(x + 430, y + 120, 70, 70)).fill()
    fill(NSColor(calibratedRed: 0.86, green: 0.62, blue: 0.34, alpha: 1), rect(x, y + h * 0.55, w, h * 0.45))
    for (i, dune) in [(0.0, 0.50), (0.35, 0.60), (0.65, 0.53)].enumerated() {
        let path = NSBezierPath()
        let base = y + h
        path.move(to: point(x + w * dune.0 - 120, base))
        path.curve(to: point(x + w * dune.0 + 260, base),
                   controlPoint1: point(x + w * dune.0, y + h * dune.1),
                   controlPoint2: point(x + w * dune.0 + 140, y + h * dune.1))
        path.close()
        NSColor(calibratedRed: 0.93 - Double(i) * 0.05, green: 0.70 - Double(i) * 0.04, blue: 0.40, alpha: 1).setFill()
        NSGraphicsContext.current?.saveGraphicsState()
        NSBezierPath(rect: rect(x, y, w, h)).addClip()
        path.fill()
        NSGraphicsContext.current?.restoreGraphicsState()
    }
    camel(x + 120, y + 290, 1.0)
    camel(x + 230, y + 300, 0.85)
    // A small tent far away.
    let tent = NSBezierPath()
    tent.move(to: point(x + 470, y + 300))
    tent.line(to: point(x + 500, y + 262))
    tent.line(to: point(x + 530, y + 300))
    tent.close()
    NSColor(calibratedRed: 0.95, green: 0.95, blue: 0.92, alpha: 1).setFill()
    tent.fill()
    // A mug on the desk, outside the photo.
    fill(NSColor(calibratedRed: 0.20, green: 0.45, blue: 0.62, alpha: 1), rect(1010, 560, 110, 130))
}

render("korean-notes.jpg") {
    fill(NSColor(calibratedRed: 0.30, green: 0.30, blue: 0.32, alpha: 1), rect(0, 0, width, height))
    let x = 180.0, y = 60.0, w = 920.0, h = 860.0
    fill(NSColor(calibratedRed: 0.98, green: 0.97, blue: 0.92, alpha: 1), rect(x, y, w, h))
    for line in stride(from: y + 110, to: y + h - 20, by: 70) {
        fill(NSColor(calibratedRed: 0.70, green: 0.80, blue: 0.95, alpha: 1), rect(x + 30, line, w - 60, 2))
    }
    let title = NSFont(name: "AppleSDGothicNeo-Bold", size: 44) ?? NSFont.boldSystemFont(ofSize: 44)
    let body = NSFont(name: "AppleSDGothicNeo-Regular", size: 40) ?? NSFont.systemFont(ofSize: 40)
    let ink = NSColor(calibratedRed: 0.10, green: 0.15, blue: 0.40, alpha: 1)
    text("여행 이야기 (Trip story)", x + 50, y + 40, title, ink)
    let lines = [
        "사막 = desert",
        "낙타 = camel",
        "모로코에 갓어요. (I went to Morocco.)",
        "낙타를 탔어요. (I rode a camel.)",
        "아주 조용했어요. (It was very quiet.)",
    ]
    for (i, line) in lines.enumerated() {
        text(line, x + 50, y + 135 + Double(i) * 70, body, ink)
    }
}
