import AVFoundation
import AppKit
// Usage: frames <video> <outdir> <sec> [sec...]  -> PNG frames for checking a recording
let a = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let gen = AVAssetImageGenerator(asset: asset)
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
gen.maximumSize = CGSize(width: 1400, height: 1000)
let sem = DispatchSemaphore(value: 0)
Task {
  let d = try await asset.load(.duration)
  print("duration", String(format: "%.1f", d.seconds))
  for s in a.dropFirst(3) {
    let t = CMTime(seconds: Double(s)!, preferredTimescale: 600)
    let (img, _) = try await gen.image(at: t)
    let rep = NSBitmapImageRep(cgImage: img)
    try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(a[2])/frame-\(s).png"))
  }
  sem.signal()
}
sem.wait()
