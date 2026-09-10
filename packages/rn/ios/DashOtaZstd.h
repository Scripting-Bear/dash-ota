#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * zstd decompression for the OTA blob pipeline.
 *
 * Apple's Compression framework has no zstd, and the wire format is zstd on every platform, so
 * upstream's single-file decompressor is vendored in `ios/vendor` — see the README there.
 *
 * This is Objective-C rather than Swift because the pod builds as a framework, and Swift cannot
 * reach a C header in its own framework target: bridging headers are rejected outright there. A
 * public Objective-C header goes into the pod's umbrella, which Swift in the same target can use
 * with no extra configuration.
 *
 * The whole operation lives here, hashing included, so the plaintext is read once rather than
 * written and then re-read to verify.
 */
@interface DashOtaZstd : NSObject

/**
 * Decompress a zstd frame from one file into another, hashing the output as it goes.
 *
 * Streamed, so peak memory is one buffer regardless of how large the bundle is. Bounded twice: the
 * frame header is compared against the size the signed manifest promises before any work starts,
 * which refuses a decompression bomb after a few bytes, and the output is counted as it is written
 * so a frame that lies about its own size cannot overrun the limit either.
 *
 * `destPath` never survives a failure.
 *
 * @param srcPath compressed input.
 * @param destPath written with the plaintext.
 * @param expectedSize plaintext size from the signed manifest.
 * @param error set on failure.
 * @return lowercase hex sha-256 of what was written, or nil on failure.
 */
+ (nullable NSString *)decompressFileAtPath:(NSString *)srcPath
                                     toPath:(NSString *)destPath
                               expectedSize:(NSUInteger)expectedSize
                                      error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
