// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "open-dot-notch",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "open-dot-notch", path: "Sources"),
    .testTarget(name: "NotchTests", dependencies: ["open-dot-notch"], path: "Tests", exclude: ["Fixtures"]),
  ]
)
