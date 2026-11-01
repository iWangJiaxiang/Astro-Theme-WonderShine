import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

for (const key of ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
const keystore = resolve(process.env.RUNNER_TEMP, 'studio-release.jks');
writeFileSync(keystore, Buffer.from(process.env.ANDROID_KEYSTORE_BASE64, 'base64'), { mode: 0o600 });
const file = 'apps/studio/src-tauri/gen/android/app/build.gradle.kts';
const source = readFileSync(file, 'utf8');
if (source.includes('STUDIO_RELEASE_SIGNING')) throw new Error('Signing has already been configured');
if ((source.match(/buildTypes \{/g) || []).length !== 1 || (source.match(/getByName\("release"\) \{/g) || []).length !== 1) throw new Error('Unexpected Tauri Gradle template');
// Secrets remain environment lookups, never Kotlin source or logs.
const signing = `// STUDIO_RELEASE_SIGNING
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("STUDIO_KEYSTORE_PATH"))
            storePassword = System.getenv("ANDROID_STORE_PASSWORD")
            keyAlias = System.getenv("ANDROID_KEY_ALIAS")
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {`;
writeFileSync(file, source.replace('buildTypes {', signing).replace('getByName("release") {', 'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")'));
writeFileSync(process.env.GITHUB_ENV, `STUDIO_KEYSTORE_PATH=${keystore}\n`, { flag: 'a' });
