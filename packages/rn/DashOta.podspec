require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "DashOta"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/Scripting-Bear/dash-ota.git", :tag => "react-native-dash-ota@#{s.version}" }

  # `.c` is here for ios/vendor/zstddeclib.c, upstream zstd's single-file decompressor. Apple has
  # no zstd and the wire format is zstd on every platform; see ios/vendor/README.md.
  s.source_files = "ios/**/*.{h,m,mm,c,swift,cpp}"
  # The Swift store tests are top-level code with their own `main`; compiling them into the pod
  # would break the host app's build. They run via `npm run test:ios`, not Xcode.
  s.exclude_files = "ios/__tests__/**/*"
  # DashOtaZstd.h is deliberately public: the pod builds as a framework, where bridging headers are
  # rejected, so a public Objective-C header in the umbrella is how Swift reaches the vendored C.
  s.public_header_files = "ios/DashOtaZstd.h"
  s.private_header_files = ["ios/DashOta.h", "ios/vendor/*.h"]

  s.pod_target_xcconfig = {
    "HEADER_SEARCH_PATHS" => "${PODS_TARGET_SRCROOT}/ios/vendor",
    # Rename every global symbol the vendored decoder defines. Pods usually link statically, and a
    # host app that also links a libzstd would otherwise share symbol names with this copy — under
    # Apple's static-link model that does not reliably error, it can silently resolve our calls
    # against the other implementation. Visibility flags do not help: they control who may see a
    # symbol, not what it is called. See scripts/generate-zstd-prefix.mjs.
    "OTHER_CFLAGS" => "$(inherited) -include ${PODS_TARGET_SRCROOT}/ios/vendor/zstd_symbol_prefix.h",
    # The vendored decoder is upstream code; do not fail the build on its warnings.
    "GCC_WARN_INHIBIT_ALL_WARNINGS" => "YES",
  }

  install_modules_dependencies(s)
end
