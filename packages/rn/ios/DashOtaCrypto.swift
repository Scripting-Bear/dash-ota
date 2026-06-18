import Foundation
import CryptoKit

/// Trust-critical crypto for iOS, mirroring the shared `openRelease` reference using Apple's
/// CryptoKit (package-based): Ed25519 verification, AES-256-GCM decryption, SHA-256, HMAC, and
/// the SOA1 archive format.
enum DashOtaCrypto {
  static func b64(_ s: String) -> Data? { Data(base64Encoded: s) }

  /// Verify against any embedded key (key ring); true if one validates.
  static func ed25519VerifyAny(publicKeysB64: [String], message: Data, signature: Data) -> Bool {
    for key in publicKeysB64 where !key.isEmpty {
      guard let raw = b64(key) else { continue }
      if let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: raw),
         pub.isValidSignature(signature, for: message) {
        return true
      }
    }
    return false
  }

  /// AES-256-GCM decrypt (throws if the tag fails to authenticate).
  static func aesGcmDecrypt(key: Data, iv: Data, ciphertext: Data, tag: Data) throws -> Data {
    let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: iv), ciphertext: ciphertext, tag: tag)
    return try AES.GCM.open(box, using: SymmetricKey(data: key))
  }

  static func sha256Hex(_ data: Data) -> String { hex(Data(SHA256.hash(data: data))) }

  static func hmacSha256Hex(key: Data, message: Data) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key))
    return hex(Data(mac))
  }

  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  /// Unpack a "SOA1" archive: magic(4) + uint32BE headerLen + header JSON [{path,size}] + blobs.
  static func unpackArchive(_ buf: Data) throws -> [(path: String, data: Data)] {
    guard buf.count >= 8, String(data: buf.subdata(in: 0..<4), encoding: .ascii) == "SOA1" else {
      throw DashOtaError.message("bad archive magic")
    }
    let headerLen = Int(buf[4]) << 24 | Int(buf[5]) << 16 | Int(buf[6]) << 8 | Int(buf[7])
    let headerEnd = 8 + headerLen
    guard buf.count >= headerEnd else { throw DashOtaError.message("truncated archive header") }
    let headerJson = try JSONSerialization.jsonObject(with: buf.subdata(in: 8..<headerEnd))
    guard let entries = headerJson as? [[String: Any]] else { throw DashOtaError.message("bad archive header") }
    var out: [(String, Data)] = []
    var offset = headerEnd
    for entry in entries {
      guard let path = entry["path"] as? String, let size = entry["size"] as? Int else {
        throw DashOtaError.message("bad archive entry")
      }
      guard buf.count >= offset + size else { throw DashOtaError.message("truncated archive blob") }
      out.append((path, buf.subdata(in: offset..<(offset + size))))
      offset += size
    }
    return out
  }
}

/// Simple error type carrying a code/message for the TurboModule promise rejection.
enum DashOtaError: Error {
  case message(String)
  var text: String { if case .message(let m) = self { return m } else { return "dash-ota error" } }
}
