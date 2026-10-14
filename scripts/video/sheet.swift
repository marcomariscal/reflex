import AVFoundation
import AppKit
// Usage: sheet <video> <out.png> <start> <end> <step> [cols] [x y w h]  -> labeled grid of stills for checking a cut
// The optional crop is in fractions of the frame (0-1, origin top-left).
let a = CommandLine.arguments
let asset = AVURLAsset(url: URL(fileURLWithPath: a[1]))
let start = Double(a[3])!, end = Double(a[4])!, step = Double(a[5])!
let cols = a.count > 6 ? Int(a[6])! : 6
let crop = a.count > 10 ? (Double(a[7])!, Double(a[8])!, Double(a[9])!, Double(a[10])!) : (0.0, 0.0, 1.0, 1.0)
let gen = AVAssetImageGenerator(asset: asset)
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
let cellW = 400.0, cellH = 225.0, label = 22.0
gen.maximumSize = CGSize(width: 1920, height: 1080)
let times = stride(from: start, through: end, by: step).map { $0 }
let rows = (times.count + cols - 1) / cols
let sheet = NSImage(size: NSSize(width: cellW * Double(cols), height: (cellH + label) * Double(rows)))
let sem = DispatchSemaphore(value: 0)
Task {
  var frames: [(Double, CGImage)] = []
  for s in times {
    if let (img, _) = try? await gen.image(at: CMTime(seconds: s, preferredTimescale: 600)) {
      let w = Double(img.width), h = Double(img.height)
      let r = CGRect(x: crop.0 * w, y: crop.1 * h, width: crop.2 * w, height: crop.3 * h)
      frames.append((s, img.cropping(to: r) ?? img))
    }
  }
  sheet.lockFocus()
  NSColor.black.setFill()
  NSRect(origin: .zero, size: sheet.size).fill()
  for (i, (s, img)) in frames.enumerated() {
    let x = Double(i % cols) * cellW, y = sheet.size.height - Double(i / cols + 1) * (cellH + label)
    NSImage(cgImage: img, size: .zero).draw(in: NSRect(x: x, y: y, width: cellW, height: cellH))
    NSString(string: String(format: "%.1fs", s)).draw(at: NSPoint(x: x + 6, y: y + cellH + 2),
      withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 15, weight: .semibold), .foregroundColor: NSColor.yellow])
  }
  sheet.unlockFocus()
  let rep = NSBitmapImageRep(data: sheet.tiffRepresentation!)!
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
  print("sheet", frames.count, "frames ->", a[2])
  sem.signal()
}
sem.wait()
