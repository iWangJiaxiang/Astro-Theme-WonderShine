// Tauri creates the XcodeGen spec at init. Link SDK libraries in the Xcode target
// that consumes the Rust static archive; Tauri filters the xcodebuild environment.
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../src-tauri/gen/apple/project.yml', import.meta.url));
const spec = await readFile(project, 'utf8');
const sdk = '      - sdk: Security.framework';
if (!spec.split('\n').includes(sdk)) throw new Error('Cannot locate the iOS SDK dependencies in the generated XcodeGen spec');
const missing = ['libz.tbd', 'libiconv.tbd'].map(library => '      - sdk: ' + library)
  .filter(line => !spec.split('\n').includes(line));
if (missing.length) await writeFile(project, spec.replace(sdk, [sdk, ...missing].join('\n')));
execFileSync('xcodegen', ['generate', '--spec', project], { stdio: 'inherit' });
