import Foundation

/// The early bundle-resolution hook. The host app's Swift `AppDelegate` calls this from
/// `bundleURL()` (release branch only) so the active OTA bundle (or embedded fallback) is
/// chosen before React starts. Runs the crash-loop circuit breaker. Returns nil to fall back
/// to the embedded bundle (fail closed).
///
/// Resolved ONCE per process. `RCTReactNativeFactory` reads `delegate.bundleURL` more than once
/// per launch and the template's `sourceURL(for:)` forwards to `bundleURL()` too, so an
/// un-memoised resolve spends a boot attempt per call and trips the crash-loop breaker on the
/// very first launch of a new bundle — which `gc()`s the slot directory out from under the running
/// bundle (all bundled images vanish) and reverts the update on the next launch.
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
  private static let lock = NSLock()
  private static var resolvedOnce = false
  private static var resolved: URL?

  /// The active OTA bundle URL, or nil to fall back to the embedded bundle.
  @objc public static func bundleURL() -> URL? {
    lock.lock()
    defer { lock.unlock() }
    if !resolvedOnce {
      resolved = DashOtaStore.shared.resolveBundleAtLaunch().map { URL(fileURLWithPath: $0) }
      resolvedOnce = true
    }
    return resolved
  }
}
