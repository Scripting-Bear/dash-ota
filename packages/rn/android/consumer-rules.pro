# zstd-jni's native code resolves Java members by name (FindClass / GetFieldID), which R8 cannot
# see. The AGP default rule keeps native method names but not ZstdInputStreamNoFinalizer's private
# srcPos/dstPos, so R8 renames them and every OTA download fails — release builds only.
# zstd-jni ships no consumer rules of its own.
-keep class com.github.luben.zstd.** { *; }
