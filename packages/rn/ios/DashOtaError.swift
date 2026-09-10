import Foundation

/// Simple error type carrying a code/message for the TurboModule promise rejection.
///
/// Its own file so the store and the crypto layer can each be compiled without the other: the
/// crypto layer pulls in the vendored zstd through an Objective-C header, which the store does not
/// need. That is what lets `scripts/test-ios.sh` build the store on its own.
enum DashOtaError: Error {
  case message(String)
  var text: String { if case .message(let m) = self { return m } else { return "dash-ota error" } }
}
