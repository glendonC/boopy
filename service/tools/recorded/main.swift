// Reads one recorded photo or video that the service already holds in its private store, on this
// Mac, and prints JSON on stdout. It reads capture-date fields only: never a location, a device
// name or any other metadata value. Stills are written upright, in standard dynamic range, at most
// the given long edge (never enlarged), as JPEG with no metadata copied from the source.
//
// Usage:
//   boopy-recorded probe-video <file>
//   boopy-recorded stills-video <file> <folder> <long-edge> <value/timescale>...
//   boopy-recorded probe-photo <file>
//   boopy-recorded still-photo <file> <folder> <long-edge>
// A failure prints {"error":"<code>"} and exits 2. No path or metadata value is ever printed.

import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

umask(0o077)

func emit(_ object: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        exit(3)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ code: String) -> Never {
    emit(["error": code])
    exit(2)
}

/// Writes an image as JPEG with no properties beyond its quality, so nothing from the source
/// (time, place, device) is copied. The service re-encodes it again before keeping it.
func writeJpeg(_ image: CGImage, to url: URL) {
    guard let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else { fail("still_write") }
    CGImageDestinationAddImage(
        destination, image, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
    if !CGImageDestinationFinalize(destination) { fail("still_write") }
}

func run(_ work: @escaping () async -> Void) {
    let done = DispatchSemaphore(value: 0)
    Task {
        await work()
        done.signal()
    }
    done.wait()
}

struct Track {
    let track: AVAssetTrack
    let natural: CGSize
    let rotation: Int
    let upright: CGSize
}

/// The single video track and its display rotation. Only whole quarter turns without mirroring
/// or scaling are accepted, so a normalized point maps to the stored pixels by one known turn.
func videoTrack(_ asset: AVURLAsset) async -> Track {
    guard let tracks = try? await asset.loadTracks(withMediaType: .video), tracks.count == 1,
        let track = tracks.first,
        let natural = try? await track.load(.naturalSize),
        let transform = try? await track.load(.preferredTransform)
    else { fail("video_tracks") }
    let quarter: [(CGFloat, CGFloat, CGFloat, CGFloat, Int)] = [
        (1, 0, 0, 1, 0), (0, 1, -1, 0, 90), (-1, 0, 0, -1, 180), (0, -1, 1, 0, 270),
    ]
    guard
        let match = quarter.first(where: {
            transform.a == $0.0 && transform.b == $0.1 && transform.c == $0.2 && transform.d == $0.3
        })
    else { fail("unsupported_transform") }
    let turned = match.4 == 90 || match.4 == 270
    let upright = turned ? CGSize(width: natural.height, height: natural.width) : natural
    return Track(track: track, natural: natural, rotation: match.4, upright: upright)
}

/// Every displayed frame's presentation time on the movie's own timeline. Sample times are read
/// without decoding and mapped through the track's edits, so an edit list's offset is applied
/// once. Edits that change speed are refused rather than guessed.
func movieTimes(_ asset: AVURLAsset, _ track: AVAssetTrack) async -> [CMTime] {
    guard let segments = try? await track.load(.segments) else { fail("video_segments") }
    for segment in segments where !segment.isEmpty {
        let map = segment.timeMapping
        if CMTimeCompare(map.source.duration, map.target.duration) != 0 { fail("scaled_edit") }
    }
    guard let reader = try? AVAssetReader(asset: asset) else { fail("video_reader") }
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { fail("video_reader") }
    reader.add(output)
    guard reader.startReading() else { fail("video_reader") }
    var times: [CMTime] = []
    while let sample = output.copyNextSampleBuffer() {
        if CMSampleBufferGetNumSamples(sample) == 0 { continue }
        let media = CMSampleBufferGetPresentationTimeStamp(sample)
        for segment in segments where !segment.isEmpty {
            let map = segment.timeMapping
            if CMTimeRangeContainsTime(map.source, time: media) {
                times.append(CMTimeAdd(map.target.start, CMTimeSubtract(media, map.source.start)))
                break
            }
        }
        if times.count > 200_000 { fail("media_limit") }
    }
    if reader.status != .completed { fail("video_reader") }
    times.sort { CMTimeCompare($0, $1) < 0 }
    return times
}

func probeVideo(_ url: URL) async {
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    let video = await videoTrack(asset)
    guard let duration = try? await asset.load(.duration), duration.isNumeric,
        let scale = try? await video.track.load(.naturalTimeScale), scale > 0
    else { fail("video_duration") }
    let characteristics = (try? await video.track.load(.mediaCharacteristics)) ?? []
    // HLG or PQ in the format description counts as HDR even when the track is 8-bit.
    let formats = (try? await video.track.load(.formatDescriptions)) ?? []
    let transfers = formats.compactMap {
        CMFormatDescriptionGetExtension($0, extensionKey: kCMFormatDescriptionExtension_TransferFunction)
            as? String
    }
    let hdr =
        characteristics.contains(.containsHDRVideo)
        || transfers.contains(kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String)
        || transfers.contains(kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String)
    let times = await movieTimes(asset, video.track)
    if times.isEmpty { fail("video_frames") }
    emit([
        "kind": "video",
        "width": Int(video.upright.width), "height": Int(video.upright.height),
        "naturalWidth": Int(video.natural.width), "naturalHeight": Int(video.natural.height),
        "rotation": video.rotation,
        "hdr": hdr,
        "durationSeconds": duration.seconds,
        "timescale": Int(scale),
        "frames": times.map { CMTimeConvertScale($0, timescale: scale, method: .default).value },
    ])
}

func stillsVideo(_ url: URL, _ folder: URL, _ longEdge: Int, _ requested: [String]) async {
    let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    _ = await videoTrack(asset)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    generator.maximumSize = CGSize(width: longEdge, height: longEdge)
    generator.dynamicRangePolicy = .forceSDR
    var stills: [[String: Any]] = []
    for (index, text) in requested.enumerated() {
        let parts = text.split(separator: "/")
        guard parts.count == 2, let value = Int64(parts[0]), let scale = Int32(parts[1]), scale > 0
        else { fail("usage") }
        let time = CMTime(value: value, timescale: scale)
        guard let (image, actual) = try? await generator.image(at: time) else { fail("still_decode") }
        // An exact frame or nothing: a neighbouring frame would bind the person's boop to the
        // wrong moment.
        if CMTimeCompare(actual, time) != 0 { fail("inexact_frame") }
        writeJpeg(image, to: folder.appendingPathComponent("\(index).jpg"))
        stills.append(["index": index, "width": image.width, "height": image.height])
    }
    emit(["stills": stills])
}

func photoSource(_ url: URL) -> (CGImageSource, Int) {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
        let type = CGImageSourceGetType(source) as String?,
        [UTType.heic.identifier, UTType.heif.identifier, UTType.jpeg.identifier, UTType.png.identifier]
            .contains(type),
        CGImageSourceGetCount(source) >= 1
    else { fail("photo_type") }
    return (source, CGImageSourceGetPrimaryImageIndex(source))
}

func probePhoto(_ url: URL) {
    let (source, primary) = photoSource(url)
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, primary, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int, width > 0, height > 0
    else { fail("photo_size") }
    let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
    if !(1...8).contains(orientation) { fail("photo_orientation") }
    // Only the three capture-date fields are read from the EXIF block. The GPS block is never read.
    let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
    func text(_ key: CFString) -> Any { (exif[key] as? String) ?? NSNull() }
    let turned = orientation >= 5
    emit([
        "kind": "photo",
        "width": turned ? height : width, "height": turned ? width : height,
        "naturalWidth": width, "naturalHeight": height,
        "orientation": orientation,
        "dateTimeOriginal": text(kCGImagePropertyExifDateTimeOriginal),
        "offsetTimeOriginal": text(kCGImagePropertyExifOffsetTimeOriginal),
        "subsecTimeOriginal": text(kCGImagePropertyExifSubsecTimeOriginal),
    ])
}

func stillPhoto(_ url: URL, _ folder: URL, _ longEdge: Int) {
    let (source, primary) = photoSource(url)
    let options = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: longEdge,
        kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, primary, options) else {
        fail("still_decode")
    }
    writeJpeg(image, to: folder.appendingPathComponent("0.jpg"))
    emit(["stills": [["index": 0, "width": image.width, "height": image.height]]])
}

let arguments = CommandLine.arguments
guard arguments.count >= 3 else { fail("usage") }
let file = URL(fileURLWithPath: arguments[2])
switch arguments[1] {
case "probe-video":
    run { await probeVideo(file) }
case "stills-video":
    guard arguments.count >= 6, let longEdge = Int(arguments[4]), (64...4096).contains(longEdge)
    else { fail("usage") }
    let folder = URL(fileURLWithPath: arguments[3])
    let times = Array(arguments[5...])
    run { await stillsVideo(file, folder, longEdge, times) }
case "probe-photo":
    probePhoto(file)
case "still-photo":
    guard arguments.count == 5, let longEdge = Int(arguments[4]), (64...4096).contains(longEdge)
    else { fail("usage") }
    stillPhoto(file, URL(fileURLWithPath: arguments[3]), longEdge)
default:
    fail("usage")
}
