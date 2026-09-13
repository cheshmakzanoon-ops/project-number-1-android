# The companion is not minified in release; this file exists so the release
# build configuration is complete and obvious. If minification is enabled
# later, LiveKit's consumer rules cover the SDK.
-keep class io.livekit.** { *; }
