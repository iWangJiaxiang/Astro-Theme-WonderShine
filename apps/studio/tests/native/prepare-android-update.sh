#!/usr/bin/env bash
set -euo pipefail
# Reuse the runner's debug keystore. Only the emulator ABI is needed.
version="$(node -e 'console.log((Number(process.env.STUDIO_VERSION.split(".")[0])+1)+".0.0")')"
npm exec -w @wondershine/studio -- tauri android build --ci --debug --apk --target x86_64 --config "{\"version\":\"$version\"}"
apk="$(find apps/studio/src-tauri/gen/android/app/build/outputs/apk -name '*.apk' -type f -printf '%T@ %p\n' | sort -rn | head -1 | cut -d' ' -f2-)"
test -s "$apk"
other="$RUNNER_TEMP/studio-other-signer.apk"
keytool -genkeypair -keystore "$RUNNER_TEMP/other.jks" -storepass fixture -keypass fixture -alias other -dname CN=Fixture -keyalg RSA -validity 2
tools_dir="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
"$tools_dir/apksigner" sign --ks "$RUNNER_TEMP/other.jks" --ks-pass pass:fixture --out "$other" "$apk"
echo "STUDIO_NEXT_APK=$apk" >> "$GITHUB_ENV"
echo "STUDIO_OTHER_SIGNER_APK=$other" >> "$GITHUB_ENV"
echo "STUDIO_NEXT_VERSION=$version" >> "$GITHUB_ENV"
