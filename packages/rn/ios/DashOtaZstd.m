#import "DashOtaZstd.h"
#import <CommonCrypto/CommonDigest.h>
#import "zstd.h"

static NSError *DashOtaZstdError(NSString *message) {
  return [NSError errorWithDomain:@"dash-ota.zstd" code:1 userInfo:@{NSLocalizedDescriptionKey : message}];
}

@implementation DashOtaZstd

+ (nullable NSString *)decompressFileAtPath:(NSString *)srcPath
                                     toPath:(NSString *)destPath
                               expectedSize:(NSUInteger)expectedSize
                                      error:(NSError **)error {
  NSFileManager *fm = NSFileManager.defaultManager;

  // Mapped, so the compressed blob is not copied into the heap just to be read.
  NSData *input = [NSData dataWithContentsOfFile:srcPath options:NSDataReadingMappedIfSafe error:error];
  if (input == nil) return nil;

  unsigned long long declared = ZSTD_getFrameContentSize(input.bytes, input.length);
  if (declared == ZSTD_CONTENTSIZE_UNKNOWN || declared == ZSTD_CONTENTSIZE_ERROR) {
    if (error) *error = DashOtaZstdError(@"zstd frame declares no content size");
    return nil;
  }
  if (declared != (unsigned long long)expectedSize) {
    if (error) {
      *error = DashOtaZstdError([NSString stringWithFormat:@"zstd frame declares %llu bytes, manifest says %lu",
                                                           declared, (unsigned long)expectedSize]);
    }
    return nil;
  }

  ZSTD_DStream *stream = ZSTD_createDStream();
  if (stream == NULL) {
    if (error) *error = DashOtaZstdError(@"zstd: out of memory");
    return nil;
  }
  ZSTD_initDStream(stream);

  [fm removeItemAtPath:destPath error:NULL];
  if (![fm createFileAtPath:destPath contents:nil attributes:nil]) {
    ZSTD_freeDStream(stream);
    if (error) *error = DashOtaZstdError([NSString stringWithFormat:@"cannot create %@", destPath.lastPathComponent]);
    return nil;
  }
  NSFileHandle *out = [NSFileHandle fileHandleForWritingAtPath:destPath];
  if (out == nil) {
    ZSTD_freeDStream(stream);
    [fm removeItemAtPath:destPath error:NULL];
    if (error) *error = DashOtaZstdError([NSString stringWithFormat:@"cannot open %@", destPath.lastPathComponent]);
    return nil;
  }

  CC_SHA256_CTX digest;
  CC_SHA256_Init(&digest);

  size_t capacity = ZSTD_DStreamOutSize();
  void *buffer = malloc(capacity);
  if (buffer == NULL) {
    ZSTD_freeDStream(stream);
    [out closeFile];
    [fm removeItemAtPath:destPath error:NULL];
    if (error) *error = DashOtaZstdError(@"zstd: out of memory");
    return nil;
  }

  ZSTD_inBuffer in = {input.bytes, input.length, 0};
  unsigned long long written = 0;
  NSString *failure = nil;

  while (in.pos < in.size) {
    ZSTD_outBuffer chunk = {buffer, capacity, 0};
    size_t rc = ZSTD_decompressStream(stream, &chunk, &in);
    if (ZSTD_isError(rc)) {
      failure = [NSString stringWithFormat:@"zstd: %s", ZSTD_getErrorName(rc)];
      break;
    }
    if (chunk.pos == 0) break;
    written += chunk.pos;
    if (written > (unsigned long long)expectedSize) {
      failure = [NSString stringWithFormat:@"zstd expanded past the %lu bytes the manifest promised",
                                           (unsigned long)expectedSize];
      break;
    }
    CC_SHA256_Update(&digest, buffer, (CC_LONG)chunk.pos);
    @try {
      [out writeData:[NSData dataWithBytesNoCopy:buffer length:chunk.pos freeWhenDone:NO]];
    } @catch (NSException *e) {
      failure = e.reason ?: @"write failed";
      break;
    }
  }

  free(buffer);
  ZSTD_freeDStream(stream);
  [out closeFile];

  if (failure == nil && written != (unsigned long long)expectedSize) {
    failure = [NSString stringWithFormat:@"zstd produced %llu bytes, manifest says %lu", written,
                                         (unsigned long)expectedSize];
  }
  if (failure != nil) {
    [fm removeItemAtPath:destPath error:NULL];
    if (error) *error = DashOtaZstdError(failure);
    return nil;
  }

  unsigned char raw[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(raw, &digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) [hex appendFormat:@"%02x", raw[i]];
  return hex;
}

@end
