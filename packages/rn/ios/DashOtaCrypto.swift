import Foundation
import CryptoKit

/// Trust-critical crypto for iOS, mirroring the shared reference implementation using Apple's
/// CryptoKit: Ed25519 verification, AES-256-GCM decryption, SHA-256 and HMAC, plus the zstd
/// decompressor vendored in `ios/vendor` because Apple's Compression framework has none.
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
  ///
  /// - Parameter aad: additional authenticated data — the plaintext hash, binding the blob to the
  ///   file it claims to be. Deliberately not the release: one blob is shared by every release
  ///   that contains that file, so binding it to one would make the shared copy unreadable.
  static func aesGcmDecrypt(key: Data, iv: Data, ciphertext: Data, tag: Data, aad: Data?) throws -> Data {
    let box = try AES.GCM.SealedBox(nonce: try AES.GCM.Nonce(data: iv), ciphertext: ciphertext, tag: tag)
    if let aad {
      return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }
    return try AES.GCM.open(box, using: SymmetricKey(data: key))
  }

  /// Decrypt one downloaded blob into a file.
  ///
  /// `AES.GCM.open` is one-shot, so the compressed blob is resident once. Android hits the same
  /// limit for a different reason (JCE will not release plaintext it has not authenticated). What
  /// this avoids on both is holding the *decompressed* bundle as well, which is several times
  /// larger and is the term that actually dominates. `dest` never survives a failure.
  static func aesGcmDecryptToFile(key: Data, iv: Data, src: URL, tag: Data, aad: Data?, dest: URL) throws {
    do {
      let ciphertext = try Data(contentsOf: src, options: .mappedIfSafe)
      let plain = try aesGcmDecrypt(key: key, iv: iv, ciphertext: ciphertext, tag: tag, aad: aad)
      try plain.write(to: dest, options: .atomic)
    } catch {
      try? FileManager.default.removeItem(at: dest)
      throw error
    }
  }

  static func sha256Hex(_ data: Data) -> String { hex(Data(SHA256.hash(data: data))) }

  /// Streaming SHA-256 of a file, so a large blob is never held in memory just to be hashed.
  static func sha256HexOfFile(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var digest = SHA256()
    while let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty {
      digest.update(data: chunk)
    }
    return hex(Data(digest.finalize()))
  }

  /// Decompress a zstd blob from a file into a file, hashing as it goes.
  ///
  /// The work is in `DashOtaZstd`, in Objective-C, because the pod builds as a framework and Swift
  /// cannot reach a C header in its own framework target. See `DashOtaZstd.h`.
  ///
  /// - Returns: hex sha-256 of what was written, for the caller to check against the manifest.
  static func zstdDecompressToFile(src: URL, dest: URL, expectedSize: Int) throws -> String {
    // Imported as `throws` because it returns a nullable object and takes an NSError out-param.
    try DashOtaZstd.decompressFile(atPath: src.path, toPath: dest.path, expectedSize: UInt(expectedSize))
  }

  static func hmacSha256Hex(key: Data, message: Data) -> String {
    let mac = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: key))
    return hex(Data(mac))
  }

  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}
