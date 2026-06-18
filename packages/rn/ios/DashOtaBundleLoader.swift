import Foundation

/// The early bundle-resolution hook. The host app's Swift `AppDelegate` calls this from
/// `bundleURL()` (release branch only) so the active OTA bundle (or embedded fallback) is
/// chosen before React starts. Runs the crash-loop circuit breaker. Returns nil to fall back
/// to the embedded bundle (fail closed).
///
/// Usage in the host `AppDelegate.swift`:
/// ```
/// import DashOta
/// override func bundleURL() -> URL? {
///   #if DEBUG
///   return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
///   #else
///   return DashOtaBundleLoader.bundleURL() ?? Bundle.main.url(forResource: "main", withExtension: "jsbundle")
///   #endif
/// }
/// ```
@objc(DashOtaBundleLoader)
public class DashOtaBundleLoader: NSObject {
  /// The active OTA bundle URL, or nil to fall back to the embedded bundle.
  @objc public static func bundleURL() -> URL? {
    guard let path = DashOtaStore.shared.resolveBundleAtLaunch() else { return nil }
    return URL(fileURLWithPath: path)
  }
}
