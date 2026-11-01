import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const credentials = {
  android: ['ANDROID_KEYSTORE_BASE64', 'ANDROID_STORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'],
  ios: ['IOS_CERTIFICATE', 'IOS_CERTIFICATE_PASSWORD', 'IOS_MOBILE_PROVISION', 'APPLE_DEVELOPMENT_TEAM'],
};

export function validateSigningConfiguration(platform, env) {
  if (!Object.hasOwn(credentials, platform)) throw new Error('Unsupported signing platform');
  const required = [...credentials[platform]];
  if (platform === 'ios' && env.STUDIO_UPLOAD_TESTFLIGHT === 'true') required.push('APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_BASE64');
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error(`Configure GitHub Actions secrets: ${missing.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validateSigningConfiguration(process.env.STUDIO_PLATFORM, process.env);
  console.log('Platform signing configuration is present; credentials will be validated by Apple or Android tooling.');
}
