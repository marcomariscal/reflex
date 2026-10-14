import AVFoundation
// Usage: render <src> <dst.mp4> <startSeconds> <speed>  -> trimmed, sped-up MP4
let a = CommandLine.arguments
let src = URL(fileURLWithPath: a[1]), dst = URL(fileURLWithPath: a[2])
let start = Double(a[3])!, speed = Double(a[4])!
let sem = DispatchSemaphore(value: 0)
Task {
  let asset = AVURLAsset(url: src)
  let dur = try await asset.load(.duration)
  let track = try await asset.loadTracks(withMediaType: .video).first!
  let comp = AVMutableComposition()
  let ct = comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)!
  let s = CMTime(seconds: start, preferredTimescale: 600)
  try ct.insertTimeRange(CMTimeRange(start: s, end: dur), of: track, at: .zero)
  ct.preferredTransform = try await track.load(.preferredTransform)
  let len = CMTimeSubtract(dur, s)
  comp.scaleTimeRange(CMTimeRange(start: .zero, duration: len), toDuration: CMTimeMultiplyByFloat64(len, multiplier: 1.0 / speed))
  try? FileManager.default.removeItem(at: dst)
  let ex = AVAssetExportSession(asset: comp, presetName: AVAssetExportPreset1920x1080)!
  ex.outputURL = dst; ex.outputFileType = .mp4; ex.shouldOptimizeForNetworkUse = true
  await ex.export()
  print(ex.status == .completed ? "ok" : "failed: \(String(describing: ex.error))")
  sem.signal()
}
sem.wait()
