// Reads text in an image with Apple's Vision framework, on this Mac, and prints it as JSON.
// Korean is available only at the accurate level. Language correction is off, so a learner's
// misspellings come back exactly as written.
//
// Usage: boopy-ocr < image.jpg
// Output: {"lines":[{"text":"...","confidence":0.9,"box":[x0,y0,x1,y1]}]}, boxes normalized
// with the origin at the top-left.

import Foundation
import ImageIO
import Vision

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("The input is not an image.")
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ko-KR", "en-US"]
request.usesLanguageCorrection = false

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fail("Vision failed: \(error.localizedDescription)")
}

var lines: [[String: Any]] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    let box = observation.boundingBox
    lines.append([
        "text": candidate.string,
        "confidence": Double(candidate.confidence),
        "box": [box.minX, 1 - box.maxY, box.maxX, 1 - box.minY].map { Double($0) },
    ])
}

let output = try JSONSerialization.data(withJSONObject: ["lines": lines], options: [])
FileHandle.standardOutput.write(output)
