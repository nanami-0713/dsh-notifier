// CoreGraphics window-list probe for dsh-notifier acceptance.
// Prints on-screen windows owned by DSHNotifier (floating layer = 3 means
// the panel floats above ordinary app windows) and the total on-screen count.
//
// Usage: swiftc scripts/winlist.swift -o /tmp/winlist && /tmp/winlist
import CoreGraphics
import Foundation

let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
var saw = false
for window in list {
  let owner = window[kCGWindowOwnerName as String] as? String ?? ""
  guard owner == "DSHNotifier" else { continue }
  let name = window[kCGWindowName as String] as? String ?? ""
  let layer = window[kCGWindowLayer as String] as? Int ?? -999
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  print("owner=\(owner) name=\(name) layer=\(layer) bounds=\(bounds)")
  saw = true
}
if !saw { print("DSHNotifier panel not on screen") }
print("total on-screen windows:", list.count)
