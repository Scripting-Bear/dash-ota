#import "DashOta.h"
// The Swift-generated interface header: angle-bracket form for framework linkage
// (use_frameworks!), quoted form for the default static-library linkage.
#if __has_include(<DashOta/DashOta-Swift.h>)
#import <DashOta/DashOta-Swift.h>
#else
#import "DashOta-Swift.h"
#endif

@implementation DashOta {
  DashOtaImpl *_impl;
}

- (instancetype)init {
  if (self = [super init]) {
    _impl = [DashOtaImpl new];
  }
  return self;
}

// --- Embedded per-flavour config (sync) ---
- (NSString *)getRuntimeVersion { return [DashOtaImpl runtimeVersion]; }
- (NSString *)getChannel { return [DashOtaImpl channel]; }
- (NSString *)getServerUrl { return [DashOtaImpl serverUrl]; }
- (NSString *)getPublicKeysB64 { return [DashOtaImpl publicKeysB64]; }
- (NSNumber *)getNativeBuildNumber { return @([DashOtaImpl nativeBuild]); }

// --- State (promises) ---
- (void)getCurrentBundleMeta:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve([_impl currentBundleMeta]);
}

- (void)getState:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve([_impl state]);
}

// --- Download + verify + stage (off the JS thread) ---
- (void)downloadAndStage:(NSString *)downloadUrl
           downloadToken:(NSString *)downloadToken
            manifestJson:(NSString *)manifestJson
            signatureB64:(NSString *)signatureB64
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSError *err = nil;
    NSDictionary *res = [self->_impl downloadAndStage:downloadUrl
                                        downloadToken:downloadToken
                                         manifestJson:manifestJson
                                         signatureB64:signatureB64
                                                error:&err];
    if (err != nil || res == nil) {
      reject(@"stage_failed", err.localizedDescription ?: @"stage failed", err);
    } else {
      resolve(res);
    }
  });
}

- (NSNumber *)isBundleDisabled:(NSString *)bundleId {
  return @([_impl isBundleDisabled:bundleId]);
}

- (NSString *)consumeFailedReport {
  return [_impl consumeFailedReport];
}

- (void)applyOnNextLaunch:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve(@([_impl applyOnNextLaunch]));
}

- (void)markHealthy { [_impl markHealthy]; }

- (void)rollback:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  resolve(@([_impl rollback]));
}

- (void)restart {
  // Best-effort only; the recommended path is apply-on-next-cold-start (see plan I3).
  dispatch_async(dispatch_get_main_queue(), ^{
    [[NSNotificationCenter defaultCenter] postNotificationName:@"RCTReloadNotification" object:nil];
  });
}

// --- Hardware-backed device identity (sync) ---
- (NSString *)getDevicePublicKeyB64 {
  return [_impl getDevicePublicKeyB64];
}

- (NSString *)signWithDeviceKey:(NSString *)message {
  return [_impl signWithDeviceKey:message];
}

- (NSString *)sha256Hex:(NSString *)message {
  return [_impl sha256Hex:message];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeDashOtaSpecJSI>(params);
}

+ (NSString *)moduleName {
  return @"DashOta";
}

@end
