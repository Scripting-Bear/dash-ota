#import "DashOta.h"
#import <React/RCTReloadCommand.h>
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
- (void)downloadAndStage:(NSString *)blobBaseUrl
           downloadToken:(NSString *)downloadToken
            manifestJson:(NSString *)manifestJson
            signatureB64:(NSString *)signatureB64
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSError *err = nil;
    NSDictionary *res = [self->_impl downloadAndStage:blobBaseUrl
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

- (NSString *)consumeAppliedReport {
  return [_impl consumeAppliedReport];
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
  // Tear down and re-create the React instance, which re-runs the AppDelegate's bundleURL() and so
  // picks up a pending OTA bundle without waiting for a cold start. Must be RN's own reload command
  // (`RCTTriggerReloadCommandListeners`): posting a hand-written notification name matches no
  // listener, so it silently does nothing. RCTHost registers this listener unconditionally, so it
  // works in release builds too. Main thread only. Cold start remains the recommended path.
  // Flag the coming launch as user-initiated so the crash-loop breaker doesn't charge it a boot
  // attempt (see DashOtaStore.markUserReload).
  [_impl markUserReload];
  dispatch_async(dispatch_get_main_queue(), ^{
    RCTTriggerReloadCommandListeners(@"dash-ota: applying update");
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

- (NSString *)generateNonce {
  return [_impl generateNonce];
}

- (NSNumber *)isDeviceKeyHardwareBacked {
  return @([_impl isDeviceKeyHardwareBacked]);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeDashOtaSpecJSI>(params);
}

+ (NSString *)moduleName {
  return @"DashOta";
}

@end
