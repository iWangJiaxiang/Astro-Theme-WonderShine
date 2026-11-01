import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This test requires macOS and a graphical login session.');
const studio = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const id = randomUUID();
const folder = join(homedir(), 'Library/Application Support/me.wondershine.studio.acceptance/workspaces', id);
const localMode = process.env.STUDIO_NATIVE_SMOKE_LOCAL === '1';
const localFolder = localMode ? await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'studio-native-local-'))) : undefined;
const root = localFolder || join(folder, 'repo'), resultPath = join(folder, 'state/native-smoke-result.json');
const profile = { id, label: 'Native acceptance fixture', provider: 'generic', url: 'https://git.example.test/native-acceptance.git', branch: 'main', username: 'fixture', authorName: 'Fixture', authorEmail: 'fixture@example.invalid' };
if (localMode) Object.assign(profile, { source: 'local', localPath: root });
const binary = process.env.STUDIO_NATIVE_SMOKE_BINARY || join(studio, 'src-tauri/target/debug/wondershine-studio');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwinr/HwAE+AKLJh4rzQAAAABJRU5ErkJggg==';
const calls = [];
let child, server;
let interrupted, spawnError;
const handleSignal = signal => { interrupted = new Error('Native acceptance interrupted: ' + signal); };
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
const checkInterrupted = () => { if (interrupted) throw interrupted; };
const stopChild = async () => {
  const running = () => child?.pid && child.exitCode === null && child.signalCode === null;
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (!running()) return;
    child.kill(signal);
    const deadline = Date.now() + 3000;
    while (running() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (running()) throw new Error('Could not stop native test process ' + child.pid);
};
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
try {
  await fs.mkdir(join(root, 'content/articles/native'), { recursive: true }); await fs.mkdir(dirname(resultPath), { recursive: true });
  await fs.writeFile(join(root, 'config.toml'), 'title="Native acceptance"\nbase_url="https://example.invalid"\ndefault_language="zh-CN"\n[languages.en]\n');
  await fs.writeFile(join(root, 'data.toml'), '');
  await fs.mkdir(join(root, 'public'), {recursive:true});await fs.writeFile(join(root, 'public/native-fixture.png'), Buffer.from(png,'base64'));
  await fs.writeFile(join(root, 'content/articles/native/index.md'), '+++\ntitle="Native acceptance article"\ndate="2026-10-31"\ndraft=true\n+++\nOriginal native article.\n');
  git(['init', '-b', 'main']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: seed native fixture']);
  git(['remote', 'add', 'origin', profile.url]); git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'])]);
  server = createServer(async (request, response) => {
    try {
      const chunks=[]; for await (const chunk of request) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(request.headers.authorization, 'Bearer fixture-native-only');
      calls.push(request.url); console.log('Native provider request: '+request.url);
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/images/generations') {response.end(JSON.stringify({data:[{b64_json:png}]}));return;}
      assert.equal(request.url, '/v1/chat/completions');
      const instruction=body.messages[0].content;
      const content=instruction.includes('Translate the JSON') ? JSON.stringify({title:'Native translated article',description:'Native translated summary.',body:'Native translated body.'}) : instruction.includes('image generation prompt') ? 'Landscape of mountains in blue light.' : 'Actual native provider summary.';
      response.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
    } catch { response.writeHead(400).end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  checkInterrupted();
  child = spawn(binary, [], { env: { ...process.env, STUDIO_NATIVE_SMOKE_CONFIG: JSON.stringify({profile,endpoint,resultPath}) }, stdio: ['ignore','pipe','pipe'] });
  child.on('error', error => { spawnError = error; });
  let processOutput=''; child.stdout.on('data',chunk=>{processOutput+=chunk});child.stderr.on('data',chunk=>{processOutput+=chunk;process.stderr.write(chunk)});
  let result;
  const started=Date.now();
  while (Date.now()-started<120000) {
    checkInterrupted();
    if (spawnError) throw spawnError;
    try { result=JSON.parse(await fs.readFile(resultPath,'utf8')); break; } catch { /* App is still testing. */ }
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Native App exited early: '+processOutput);
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(result, 'No result from App. Close any running Studio instance and build with custom-protocol,native-smoke. '+processOutput);
  const output=join(studio,localMode ? 'test-results/native-macos-local' : 'test-results/native-macos');await fs.mkdir(output,{recursive:true});await fs.writeFile(join(output,'result.json'),JSON.stringify({...result,calls},null,2));
  assert.equal(result.error,undefined);
  const article=await fs.readFile(join(root,'content/articles/native/index.md'),'utf8');
  assert.match(article,/Actual macOS WebView edit\./);assert.match(article,/Actual native provider summary\./);assert.match(article,/cover/);
  const translated=await fs.readFile(join(root,'content/articles/native/index.en.md'),'utf8');
  assert.match(translated,/Native translated body/);assert.match(translated,/ai_translation = true/);assert.match(translated,/translation_reviewed = false/);assert.match(translated,/draft\s*=\s*true/);
  assert.equal(git(['status','--porcelain']),'');assert.equal(git(['rev-list','--count','origin/main..HEAD']),'1');
  assert.deepEqual(calls,['/v1/chat/completions','/v1/chat/completions','/v1/images/generations','/v1/chat/completions']);
  console.log('Actual macOS WebView passed: '+result.results.join(', '));
  console.log('Native filesystem, Git and HTTP plugins used without IPC mocks; no remote Git push.');
  if (localMode) {
    await stopChild();await fs.rm(resultPath);
    child = spawn(binary, [], {env:{...process.env, STUDIO_NATIVE_SMOKE_CONFIG:JSON.stringify({profile,endpoint,resultPath,restoreOnly:true})},stdio:['ignore','pipe','pipe']});
    child.on('error', error => {spawnError=error});child.stderr.on('data',chunk=>process.stderr.write(chunk));
    let restored;const restarted=Date.now();
    while(Date.now()-restarted<60000){checkInterrupted();if(spawnError)throw spawnError;try{restored=JSON.parse(await fs.readFile(resultPath,'utf8'));break;}catch{}if(child.exitCode!==null||child.signalCode!==null)throw new Error('Restarted App exited early');await new Promise(r=>setTimeout(r,250));}
    assert.ok(restored,'No result from restarted local App');assert.equal(restored.error,undefined);
    assert.ok(restored.results.includes('restart-restores-local-filesystem-and-asset-scope'));
    await fs.writeFile(join(output,'restart.json'),JSON.stringify(restored,null,2));console.log('Native local folder reopened after process restart; filesystem and asset permissions restored.');
  }
} finally {
  try { await stopChild(); }
  finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    await fs.rm(folder,{recursive:true,force:true});
    if(localFolder)await fs.rm(localFolder,{recursive:true,force:true});
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  }
}
