import AVFoundation
import AppKit
import QuartzCore
// Usage: compose <spec.json> [--plan]  -> final demo MP4 from a Screen Studio export.
// The spec lists segments of the source (speed or freeze), overlays, zooms and sounds. Anything timed is
// placed either at a source time ("src") or at an offset into a segment ("seg" + "off").
// --plan prints the output timeline only.

struct Segment: Codable { let from: Double?; let to: Double?; let speed: Double?; let freeze: Double?; let dur: Double? }
struct Row: Codable { let label: String; let value: String; let bad: Bool? }
struct Overlay: Codable {
  let kind: String  // caption | card | wallets
  let src: Double?; let seg: Int?; let off: Double?
  let dur: Double
  let text: String?; let sub: String?; let alert: String?; let foot: String?
  let lines: [String]?  // card lines; "label |result" renders the label dimmer than the result
  let rows: [Row]?
  let cx: Double?; let cy: Double?  // panel center, fractions of the frame from the top-left
  let dim: Double?; let fadeIn: Bool?; let fadeOut: Bool?
}
// Push in on a point of the picture (fractions from the top-left) over `dur`. With `hold`, stay that long and
// ease back out over `back` (default `dur`); without it, stay zoomed to the end.
struct Zoom: Codable {
  let src: Double?; let seg: Int?; let off: Double?; let dur: Double; let cx: Double; let cy: Double; let scale: Double
  let hold: Double?; let back: Double?
}
struct Sound: Codable { let src: Double?; let seg: Int?; let off: Double?; let file: String; let volume: Float? }
struct Spec: Codable {
  let src: String; let out: String; let segments: [Segment]; let overlays: [Overlay]; let zooms: [Zoom]?; let sounds: [Sound]?
}

let args = CommandLine.arguments
let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
let planOnly = args.contains("--plan")
let W = 1920.0, H = 1080.0
let ts: CMTimeScale = 6000
func t(_ s: Double) -> CMTime { CMTime(seconds: s, preferredTimescale: ts) }

// Output start of each segment, and a source->output time map.
var starts: [Double] = []
var acc = 0.0
for s in spec.segments {
  starts.append(acc)
  acc += s.freeze != nil ? s.dur! : (s.to! - s.from!) / (s.speed ?? 1)
}
let total = acc
func outTime(src: Double?, seg: Int?, off: Double?) -> Double {
  if let seg { return starts[seg] + (off ?? 0) }
  let x = src!
  for (i, s) in spec.segments.enumerated() where s.freeze == nil && x >= s.from! && x <= s.to! {
    return starts[i] + (x - s.from!) / (s.speed ?? 1)
  }
  fatalError("source time \(x) is cut out of the edit")
}

if planOnly {
  for (i, s) in spec.segments.enumerated() {
    let what = s.freeze != nil ? "freeze @\(s.freeze!) for \(s.dur!)s" : "src \(s.from!)-\(s.to!) at \(s.speed ?? 1)x"
    print(String(format: "seg %2d  out %6.2f  ", i, starts[i]) + what)
  }
  for o in spec.overlays {
    let a = outTime(src: o.src, seg: o.seg, off: o.off)
    let words = o.text ?? o.lines?.joined(separator: " ") ?? ""
    let need = Double(words.count) / 15 + 1.1
    print(String(format: "%-8@ out %6.2f-%6.2f  %4.1fs (reads in %4.1fs)  ", o.kind, a, a + o.dur, o.dur, need) + words)
  }
  print(String(format: "total %.2fs", total))
  exit(0)
}

// Text is drawn into a bitmap up front: CATextLayer doesn't render in an offline export on macOS.
// Core Animation's origin is bottom-left in the export.
func font(_ size: CGFloat, _ weight: NSFont.Weight, mono: Bool = false) -> NSFont {
  mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight)
}
func white(_ a: Double) -> NSColor { NSColor(white: 1, alpha: a) }
let red = NSColor(calibratedRed: 1, green: 0.42, blue: 0.42, alpha: 1)
let green = NSColor(calibratedRed: 0.45, green: 0.9, blue: 0.6, alpha: 1)

func text(_ parts: [(String, NSFont, NSColor)], kern: Double = 0, align: NSTextAlignment = .center) -> (CALayer, CGSize) {
  let para = NSMutableParagraphStyle()
  para.alignment = align
  let str = NSMutableAttributedString()
  for (s, f, c) in parts {
    str.append(NSAttributedString(string: s, attributes: [.font: f, .foregroundColor: c, .paragraphStyle: para, .kern: kern]))
  }
  let size = CGSize(width: ceil(str.size().width) + 4, height: ceil(str.size().height) + 4)
  let scale = 2.0
  let ctx = CGContext(data: nil, width: Int(size.width * scale), height: Int(size.height * scale), bitsPerComponent: 8,
                      bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.scaleBy(x: scale, y: scale)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  str.draw(in: CGRect(x: 2, y: 2, width: size.width - 4, height: size.height - 4))
  NSGraphicsContext.restoreGraphicsState()
  let l = CALayer()
  l.contents = ctx.makeImage()
  l.frame = CGRect(origin: .zero, size: size)
  return (l, size)
}
func text(_ s: String, _ f: NSFont, _ c: NSColor, kern: Double = 0, align: NSTextAlignment = .center) -> (CALayer, CGSize) {
  text([(s, f, c)], kern: kern, align: align)
}

func begin(_ t0: Double) -> CFTimeInterval { t0 == 0 ? AVCoreAnimationBeginTimeAtZero : t0 }
func fade(_ layer: CALayer, at t0: Double, dur: Double, fadeIn: Bool = true, fadeOut: Bool = true) {
  layer.opacity = 0
  let f = min(0.3, dur / 4)
  let a = CAKeyframeAnimation(keyPath: "opacity")
  a.values = [fadeIn ? 0 : 1, 1, 1, fadeOut ? 0 : 1]
  a.keyTimes = [0, NSNumber(value: f / dur), NSNumber(value: (dur - f) / dur), 1]
  a.beginTime = begin(t0)
  a.duration = dur
  a.isRemovedOnCompletion = false
  a.fillMode = .both
  layer.add(a, forKey: "fade")
}
// One eased move of a property, held before and after.
func ease(_ layer: CALayer, _ key: String, from: Any, to: Any, at t0: Double, dur: Double) {
  let a = CABasicAnimation(keyPath: key)
  a.fromValue = from
  a.toValue = to
  a.beginTime = begin(t0)
  a.duration = dur
  a.timingFunction = CAMediaTimingFunction(name: .easeOut)
  a.isRemovedOnCompletion = false
  a.fillMode = .both
  layer.add(a, forKey: key)
}
func dimLayer(_ opacity: Double) -> CALayer {
  let d = CALayer()
  d.frame = CGRect(x: 0, y: 0, width: W, height: H)
  d.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.03, blue: 0.07, alpha: opacity).cgColor
  return d
}

func build(_ o: Overlay, at t0: Double) -> CALayer {
  let root = CALayer()
  root.frame = CGRect(x: 0, y: 0, width: W, height: H)
  switch o.kind {
  case "caption":
    let (l, sz) = text(o.text!, font(40, .semibold), .white)
    let pill = CALayer()
    pill.frame = CGRect(x: (W - sz.width - 72) / 2, y: 12, width: sz.width + 72, height: sz.height + 28)
    pill.backgroundColor = NSColor(calibratedRed: 0.06, green: 0.06, blue: 0.10, alpha: 0.92).cgColor
    pill.cornerRadius = pill.frame.height / 2
    pill.borderWidth = 1
    pill.borderColor = white(0.14).cgColor
    l.frame.origin = CGPoint(x: 36, y: 14)
    pill.addSublayer(l)
    root.addSublayer(pill)
    ease(pill, "position.y", from: pill.position.y - 12, to: pill.position.y, at: t0, dur: 0.35)
  case "card":
    root.addSublayer(dimLayer(o.dim ?? 0.88))
    let lines = o.lines ?? []
    let title = text(o.text!, font(lines.isEmpty ? 112 : 96, .bold), .white, kern: -2.5)
    let sub = o.sub.map { text($0, font(40, .regular), white(0.85)) }
    let rendered = lines.map { line -> (CALayer, CGSize) in
      let p = line.components(separatedBy: "|")
      return p.count == 2 ? text([(p[0], font(40, .regular), white(0.7)), (p[1], font(40, .semibold), .white)])
                          : text(line, font(40, .regular), white(0.85))
    }
    let gap = 26.0, lineGap = 8.0
    let below = (sub.map { $0.1.height + gap } ?? 0) + rendered.reduce(0) { $0 + $1.1.height + lineGap } + (rendered.isEmpty ? 0 : gap)
    var y = H / 2 + (title.1.height + below) / 2 - title.1.height
    title.0.frame.origin = CGPoint(x: (W - title.1.width) / 2, y: y)
    root.addSublayer(title.0)
    ease(title.0, "transform.scale", from: 1.04, to: 1.0, at: t0, dur: 0.6)
    y -= gap
    if let (l, sz) = sub {
      y -= sz.height
      l.frame.origin = CGPoint(x: (W - sz.width) / 2, y: y)
      root.addSublayer(l)
      ease(l, "opacity", from: 0, to: 1, at: t0 + 0.2, dur: 0.4)
    }
    for (i, (l, sz)) in rendered.enumerated() {
      y -= sz.height + (i == 0 ? 0 : lineGap)
      l.frame.origin = CGPoint(x: (W - sz.width) / 2, y: y)
      root.addSublayer(l)
      ease(l, "opacity", from: 0, to: 1, at: t0 + 0.35 + 0.3 * Double(i), dur: 0.35)
      ease(l, "position.y", from: l.position.y - 10, to: l.position.y, at: t0 + 0.35 + 0.3 * Double(i), dur: 0.35)
    }
    if let foot = o.foot {
      let (l, sz) = text(foot, font(26, .regular), white(0.65))
      l.frame.origin = CGPoint(x: (W - sz.width) / 2, y: 64)
      root.addSublayer(l)
      ease(l, "opacity", from: 0, to: 1, at: t0 + 0.35 + 0.3 * Double(rendered.count), dur: 0.4)
    }
  case "wallets":
    root.addSublayer(dimLayer(o.dim ?? 0.45))
    let rows = o.rows ?? []
    let head = text(o.text!, font(46, .bold), .white)
    let alert = o.alert.map { text($0, font(46, .bold), red) }
    let sub = o.sub.map { text($0, font(28, .regular), white(0.75)) }
    let labels = rows.map { text($0.label, font(28, .regular), white(0.75), align: .left) }
    let values = rows.map { text($0.value, font(36, .semibold, mono: true), $0.bad == true ? red : green, align: .left) }
    let labelW = labels.map(\.1.width).max() ?? 0, valueW = values.map(\.1.width).max() ?? 0
    let rowH = 60.0, pad = 44.0
    let blocks = [head.1] + [alert?.1, sub?.1].compactMap { $0 }
    let panelW = max(blocks.map(\.width).max()!, labelW + 32 + valueW) + pad * 2
    let headH = head.1.height + (alert.map { $0.1.height + 2 } ?? 0) + (sub.map { $0.1.height + 12 } ?? 0)
    let panelH = pad * 2 + headH + 26 + rowH * Double(rows.count)
    let panel = CALayer()
    panel.frame = CGRect(x: (o.cx ?? 0.5) * W - panelW / 2, y: (1 - (o.cy ?? 0.44)) * H - panelH / 2, width: panelW, height: panelH)
    panel.backgroundColor = NSColor(calibratedRed: 0.07, green: 0.07, blue: 0.11, alpha: 0.96).cgColor
    panel.cornerRadius = 24
    panel.borderWidth = 1.5
    panel.borderColor = white(0.12).cgColor
    var y = panelH - pad
    for (l, sz) in [head] + [alert].compactMap({ $0 }) {
      y -= sz.height
      l.frame.origin = CGPoint(x: pad, y: y)
      panel.addSublayer(l)
      y -= 2
    }
    if let (l, sz) = sub {
      y -= 10 + sz.height
      l.frame.origin = CGPoint(x: pad, y: y)
      panel.addSublayer(l)
    }
    y -= 26
    for i in rows.indices {
      y -= rowH
      labels[i].0.frame.origin = CGPoint(x: pad, y: y + (rowH - labels[i].1.height) / 2)
      values[i].0.frame.origin = CGPoint(x: pad + labelW + 32, y: y + (rowH - values[i].1.height) / 2)
      if rows[i].bad == true {
        let bar = CALayer()
        bar.frame = CGRect(x: pad - 20, y: y + 10, width: 5, height: rowH - 20)
        bar.backgroundColor = red.cgColor
        bar.cornerRadius = 2.5
        panel.addSublayer(bar)
      }
      panel.addSublayer(labels[i].0)
      panel.addSublayer(values[i].0)
    }
    root.addSublayer(panel)
    ease(panel, "transform.scale", from: 0.96, to: 1.0, at: t0, dur: 0.4)
  default:
    fatalError("unknown overlay kind \(o.kind)")
  }
  return root
}

let sem = DispatchSemaphore(value: 0)
Task {
  do {
    let asset = AVURLAsset(url: URL(fileURLWithPath: spec.src))
    let track = try await asset.loadTracks(withMediaType: .video).first!
    let fps = Double(try await track.load(.nominalFrameRate))
    let comp = AVMutableComposition()
    let vt = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
    var cursor = CMTime.zero
    for s in spec.segments {
      let range = s.freeze != nil
        ? CMTimeRange(start: t(s.freeze!), duration: CMTime(value: 1, timescale: CMTimeScale(fps.rounded())))
        : CMTimeRange(start: t(s.from!), end: t(s.to!))
      try vt.insertTimeRange(range, of: track, at: cursor)
      let target = s.freeze != nil ? t(s.dur!) : CMTimeMultiplyByFloat64(range.duration, multiplier: 1 / (s.speed ?? 1))
      vt.scaleTimeRange(CMTimeRange(start: cursor, duration: range.duration), toDuration: target)
      cursor = CMTimeAdd(cursor, target)
    }

    var mixParams: [AVMutableAudioMixInputParameters] = []
    for snd in spec.sounds ?? [] {
      let a = AVURLAsset(url: URL(fileURLWithPath: snd.file))
      guard let at = try await a.loadTracks(withMediaType: .audio).first else { continue }
      let d = try await a.load(.duration)
      let ct = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)!
      try ct.insertTimeRange(CMTimeRange(start: .zero, duration: d), of: at, at: t(outTime(src: snd.src, seg: snd.seg, off: snd.off)))
      let p = AVMutableAudioMixInputParameters(track: ct)
      p.setVolume(snd.volume ?? 0.5, at: .zero)
      mixParams.append(p)
    }
    let mix = AVMutableAudioMix()
    mix.inputParameters = mixParams

    let vc = AVMutableVideoComposition(propertiesOf: comp)
    vc.renderSize = CGSize(width: W, height: H)
    vc.frameDuration = CMTime(value: 1, timescale: 60)
    // Render every 1/60s. Following the source track's timing would skip freezes (one stretched sample)
    // and the overlays drawn on them.
    vc.sourceTrackIDForFrameTiming = kCMPersistentTrackID_Invalid
    // This thread has no run loop to commit implicit transactions, so build the tree in an explicit one.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let parent = CALayer(), videoLayer = CALayer()
    parent.frame = CGRect(x: 0, y: 0, width: W, height: H)
    videoLayer.frame = parent.frame
    parent.addSublayer(videoLayer)
    for (i, z) in (spec.zooms ?? []).enumerated() {
      let q = (x: z.cx * W - W / 2, y: (1 - z.cy) * H - H / 2)
      let to = CATransform3DConcat(CATransform3DMakeScale(z.scale, z.scale, 1),
                                   CATransform3DMakeTranslation(-z.scale * q.x, -z.scale * q.y, 0))
      let id = NSValue(caTransform3D: CATransform3DIdentity), zoomed = NSValue(caTransform3D: to)
      let a = CAKeyframeAnimation(keyPath: "transform")
      let ease = CAMediaTimingFunction(name: .easeInEaseOut), flat = CAMediaTimingFunction(name: .linear)
      if let hold = z.hold {
        let back = z.back ?? z.dur, total = z.dur + hold + back
        a.values = [id, zoomed, zoomed, id]
        a.keyTimes = [0, NSNumber(value: z.dur / total), NSNumber(value: (z.dur + hold) / total), 1]
        a.timingFunctions = [ease, flat, ease]
        a.duration = total
      } else {
        a.values = [id, zoomed]
        a.timingFunctions = [ease]
        a.duration = z.dur
      }
      a.beginTime = begin(outTime(src: z.src, seg: z.seg, off: z.off))
      a.isRemovedOnCompletion = false
      // Forwards only: a backwards fill would hold this zoom's start over any earlier zoom still running.
      a.fillMode = .forwards
      videoLayer.add(a, forKey: "zoom\(i)")
    }
    for o in spec.overlays {
      let at = outTime(src: o.src, seg: o.seg, off: o.off)
      let l = build(o, at: at)
      fade(l, at: at, dur: o.dur, fadeIn: o.fadeIn ?? true, fadeOut: o.fadeOut ?? true)
      parent.addSublayer(l)
    }
    CATransaction.commit()
    vc.animationTool = AVVideoCompositionCoreAnimationTool(postProcessingAsVideoLayer: videoLayer, in: parent)

    let dst = URL(fileURLWithPath: spec.out)
    try? FileManager.default.removeItem(at: dst)
    let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPreset1920x1080)!
    ex.videoComposition = vc
    ex.audioMix = mix
    ex.outputURL = dst
    ex.outputFileType = .mp4
    ex.shouldOptimizeForNetworkUse = true
    await ex.export()
    print(ex.status == .completed ? String(format: "ok %.2fs -> %@", total, spec.out) : "failed: \(String(describing: ex.error))")
  } catch {
    print("error: \(error)")
  }
  sem.signal()
}
sem.wait()
