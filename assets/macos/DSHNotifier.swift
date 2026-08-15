// DSHNotifier — macOS always-on-top floating alert panel for dsh-notifier.
//
// Usage:
//   DSHNotifier --title "..." --message "..." --kind done|approval|question|error
//               [--primary "去处理"] [--secondary "知道了"] [--url "http://..."]
//               [--ttl 8] [--screenshot out.png]
//
// Panel behavior:
//   - NSPanel with .floating level + .canJoinAllSpaces + .fullScreenAuxiliary:
//     visible above every app window, on every Space, and over full-screen apps.
//   - The card itself is drawn into an NSImage (pixel-identical to the
//     --screenshot output) and shown in an NSImageView; transparent NSButtons
//     are overlaid for the actions.
//   - --ttl 0 means sticky (wait for a button click); ttl > 0 auto-closes.

import AppKit
import Foundation

enum NotifyKind: String {
  case done, approval, question, error
}

struct Args {
  var title = "DSH 提醒"
  var message = ""
  var kind = NotifyKind.done
  var primary: String?
  var secondary: String?
  var url: String?
  var ttl: Double = 8
  var screenshotPath: String?
}

func parseArgs() -> Args {
  var args = Args()
  let raw = Array(CommandLine.arguments.dropFirst())
  var index = 0
  while index < raw.count {
    let key = raw[index]
    func next() -> String? {
      index += 1
      return index < raw.count ? raw[index] : nil
    }
    switch key {
    case "--title": args.title = next() ?? args.title
    case "--message": args.message = next() ?? args.message
    case "--kind": args.kind = NotifyKind(rawValue: next() ?? "") ?? .done
    case "--primary": args.primary = next()
    case "--secondary": args.secondary = next()
    case "--url": args.url = next()
    case "--ttl": args.ttl = Double(next() ?? "") ?? 8
    case "--screenshot": args.screenshotPath = next()
    default: break
    }
    index += 1
  }
  return args
}

func accentColor(_ kind: NotifyKind) -> NSColor {
  switch kind {
  case .done: return NSColor(calibratedRed: 0.20, green: 0.83, blue: 0.60, alpha: 1)
  case .approval: return NSColor(calibratedRed: 0.98, green: 0.75, blue: 0.14, alpha: 1)
  case .question: return NSColor(calibratedRed: 0.38, green: 0.65, blue: 0.98, alpha: 1)
  case .error: return NSColor(calibratedRed: 0.97, green: 0.44, blue: 0.44, alpha: 1)
  }
}

func kindIcon(_ kind: NotifyKind) -> String {
  switch kind {
  case .done: return "✅"
  case .approval: return "⚠️"
  case .question: return "❓"
  case .error: return "❌"
  }
}

struct ButtonLayout {
  var primaryRect: CGRect?
  var secondaryRect: CGRect?
}

let CARD_WIDTH: CGFloat = 408
let PADDING: CGFloat = 16
let ICON_LEFT: CGFloat = 14
let ICON_SIZE: CGFloat = 24
let TEXT_LEFT: CGFloat = 48
let TEXT_RIGHT: CGFloat = 14

func textHeight(_ text: String, font: NSFont, width: CGFloat) -> CGFloat {
  let paragraph = NSMutableParagraphStyle()
  paragraph.lineBreakMode = .byWordWrapping
  let attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
  let rect = (text as NSString).boundingRect(
    with: NSSize(width: width, height: .greatestFiniteMagnitude),
    options: [.usesLineFragmentOrigin, .usesFontLeading],
    attributes: attributes
  )
  return ceil(rect.height)
}

func drawCard(_ args: Args) -> (NSImage, ButtonLayout) {
  let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
  let bodyFont = NSFont.systemFont(ofSize: 12, weight: .regular)
  let buttonFont = NSFont.systemFont(ofSize: 12, weight: .medium)
  let textWidth = CARD_WIDTH - TEXT_LEFT - TEXT_RIGHT

  let titleHeight = textHeight(args.title, font: titleFont, width: textWidth)
  let bodyHeight = args.message.isEmpty ? 0 : textHeight(args.message, font: bodyFont, width: textWidth)
  let hasButtons = args.primary != nil || args.secondary != nil
  let buttonRowHeight: CGFloat = hasButtons ? 48 : 12
  let height = max(ICON_SIZE + PADDING, PADDING + titleHeight + 6 + bodyHeight + buttonRowHeight)

  let image = NSImage(size: NSSize(width: CARD_WIDTH, height: height))
  image.lockFocus()
  guard let context = NSGraphicsContext.current?.cgContext else {
    image.unlockFocus()
    return (image, ButtonLayout())
  }
  context.setShouldAntialias(true)

  // Card background
  let cardRect = NSRect(x: 0, y: 0, width: CARD_WIDTH, height: height)
  let cardPath = NSBezierPath(roundedRect: cardRect, xRadius: 16, yRadius: 16)
  NSColor(calibratedRed: 0.066, green: 0.094, blue: 0.153, alpha: 0.96).setFill()
  cardPath.fill()
  NSColor(calibratedWhite: 1, alpha: 0.10).setStroke()
  cardPath.lineWidth = 1
  cardPath.stroke()

  // Left accent bar
  let accent = accentColor(args.kind)
  accent.setFill()
  let accentRect = NSRect(x: 0, y: PADDING, width: 4, height: height - PADDING * 2)
  NSBezierPath(roundedRect: accentRect, xRadius: 2, yRadius: 2).fill()

  // Icon
  let iconAttributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 16)]
  (kindIcon(args.kind) as NSString).draw(
    at: NSPoint(x: ICON_LEFT, y: height - PADDING - ICON_SIZE + 4),
    withAttributes: iconAttributes
  )

  // Title
  let titleAttributes: [NSAttributedString.Key: Any] = [
    .font: titleFont,
    .foregroundColor: NSColor(calibratedWhite: 0.98, alpha: 1),
  ]
  (args.title as NSString).draw(
    in: NSRect(x: TEXT_LEFT, y: height - PADDING - titleHeight, width: textWidth, height: titleHeight),
    withAttributes: titleAttributes
  )

  // Body
  if !args.message.isEmpty {
    let bodyAttributes: [NSAttributedString.Key: Any] = [
      .font: bodyFont,
      .foregroundColor: NSColor(calibratedWhite: 0.62, alpha: 1),
    ]
    (args.message as NSString).draw(
      in: NSRect(x: TEXT_LEFT, y: height - PADDING - titleHeight - 6 - bodyHeight, width: textWidth, height: bodyHeight),
      withAttributes: bodyAttributes
    )
  }

  var layout = ButtonLayout()
  if hasButtons {
    var rightEdge = CARD_WIDTH - PADDING
    func measure(_ text: String, font: NSFont) -> CGFloat {
      (text as NSString).size(withAttributes: [.font: font]).width + 24
    }
    if let secondary = args.secondary {
      let width = measure(secondary, font: buttonFont)
      let rect = NSRect(x: rightEdge - width, y: PADDING, width: width, height: 28)
      NSColor(calibratedWhite: 1, alpha: 0.06).setFill()
      NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8).fill()
      NSColor(calibratedWhite: 1, alpha: 0.24).setStroke()
      NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8).stroke()
      let attrs: [NSAttributedString.Key: Any] = [
        .font: buttonFont,
        .foregroundColor: NSColor(calibratedWhite: 0.90, alpha: 1),
      ]
      let textSize = (secondary as NSString).size(withAttributes: [.font: buttonFont])
      (secondary as NSString).draw(
        at: NSPoint(x: rect.midX - textSize.width / 2, y: rect.midY - textSize.height / 2),
        withAttributes: attrs
      )
      layout.secondaryRect = rect
      rightEdge = rect.minX - 8
    }
    if let primary = args.primary {
      let width = measure(primary, font: buttonFont)
      let rect = NSRect(x: rightEdge - width, y: PADDING, width: width, height: 28)
      NSColor(calibratedRed: 0.30, green: 0.42, blue: 1.0, alpha: 1).setFill()
      NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8).fill()
      let attrs: [NSAttributedString.Key: Any] = [
        .font: buttonFont,
        .foregroundColor: NSColor.white,
      ]
      let textSize = (primary as NSString).size(withAttributes: [.font: buttonFont])
      (primary as NSString).draw(
        at: NSPoint(x: rect.midX - textSize.width / 2, y: rect.midY - textSize.height / 2),
        withAttributes: attrs
      )
      layout.primaryRect = rect
    }
  }

  image.unlockFocus()
  return (image, layout)
}

func writeScreenshot(_ args: Args) {
  let (image, _) = drawCard(args)
  guard let tiff = image.tiffRepresentation,
        let rep = NSBitmapImageRep(data: tiff),
        let data = rep.representation(using: .png, properties: [:]) else {
    fputs("DSHNotifier: failed to render screenshot\n", stderr)
    exit(2)
  }
  do {
    try data.write(to: URL(fileURLWithPath: args.screenshotPath!))
    print(args.screenshotPath!)
  } catch {
    fputs("DSHNotifier: \(error)\n", stderr)
    exit(2)
  }
}

final class Delegate: NSObject, NSApplicationDelegate {
  let args: Args
  var panel: NSPanel?
  var timer: Timer?

  init(args: Args) { self.args = args }

  func applicationDidFinishLaunching(_ notification: Notification) {
    show()
  }

  func show() {
    let (image, layout) = drawCard(args)
    let size = image.size

    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: size),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovable = false
    panel.isReleasedWhenClosed = false

    let imageView = NSImageView(frame: NSRect(origin: .zero, size: size))
    imageView.image = image
    imageView.imageScaling = .scaleNone
    panel.contentView = imageView

    func overlayButton(_ rect: CGRect?, title: String, action: Selector) {
      guard let rect = rect else { return }
      let button = NSButton(frame: rect)
      button.title = ""
      button.isBordered = false
      button.setButtonType(.momentaryChange)
      button.target = self
      button.action = action
      button.toolTip = title
      imageView.addSubview(button)
    }
    overlayButton(layout.primaryRect, title: args.primary ?? "查看", action: #selector(primaryTapped))
    overlayButton(layout.secondaryRect, title: args.secondary ?? "忽略", action: #selector(dismissTapped))

    if let screen = NSScreen.main {
      let frame = screen.visibleFrame
      let origin = NSPoint(
        x: frame.maxX - size.width - 18,
        y: frame.maxY - size.height - 24
      )
      panel.setFrameOrigin(origin)
    }
    panel.orderFrontRegardless()
    self.panel = panel

    if args.ttl > 0 {
      timer = Timer.scheduledTimer(withTimeInterval: args.ttl, repeats: false) { [weak self] _ in
        NSApp.terminate(nil)
      }
    }
  }

  @objc func primaryTapped() {
    if let urlString = args.url, let url = URL(string: urlString) {
      NSWorkspace.shared.open(url)
    }
    NSApp.terminate(nil)
  }

  @objc func dismissTapped() {
    NSApp.terminate(nil)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }
}

let args = parseArgs()

if args.screenshotPath != nil {
  writeScreenshot(args)
  exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate(args: args)
app.delegate = delegate
app.run()
