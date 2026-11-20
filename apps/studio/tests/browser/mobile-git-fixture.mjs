import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Only Tauri IPC and the remote host are replaced. The Linux harness links the same
// libgit2 engine as iOS/Android and talks real smart HTTPS to a temporary bare Git repo.
export async function mobileGitFixture(base, appData, studio) {
  const ca = join(base, 'test-ca.pem'), key = join(base, 'test-key.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Studio test',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',ca], { stdio: 'ignore' });
  const backend = join(execFileSync('git',['--exec-path']).toString().trim(),'git-http-backend');
  let online = true;
  const server = createServer({ key: await readFile(key), cert: await readFile(ca) }, async (request, response) => {
    const url = new URL(request.url, 'https://127.0.0.1');
    if (!online || !['/remote.git/info/refs','/remote.git/git-upload-pack','/remote.git/git-receive-pack'].includes(url.pathname)) {
      response.writeHead(503).end(); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const output = execFileSync(backend, [], { input: Buffer.concat(chunks), env: { ...process.env,
      GIT_PROJECT_ROOT: base, GIT_HTTP_EXPORT_ALL:'1', PATH_INFO:url.pathname, REQUEST_METHOD:request.method,
      QUERY_STRING:url.search.slice(1), CONTENT_TYPE:request.headers['content-type'] || '', REMOTE_ADDR:'127.0.0.1' } });
    const end = output.indexOf('\r\n\r\n');
    assert.ok(end >= 0);
    for (const line of output.subarray(0,end).toString().split('\r\n')) {
      const colon = line.indexOf(':'), name = line.slice(0,colon), value = line.slice(colon+1).trim();
      if (name === 'Status') response.statusCode = Number(value.split(' ')[0]);
      else response.setHeader(name,value);
    }
    response.end(output.subarray(end+4));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = 'https://127.0.0.1:' + server.address().port + '/remote.git';
  async function invoke(args, progress) {
    const child = spawn(join(studio,'src-tauri/target/debug/examples/browser_fixture'), [appData, ca],
      { stdio:['pipe','pipe','inherit'] });
    const done = new Promise((resolve,reject) => {
      child.once('error',reject); child.once('close',code => code === 0 ? resolve() : reject(new Error('Native Git fixture exited ' + code)));
    });
    child.stdin.end(JSON.stringify(args));
    let result;
    for await (const line of createInterface({ input:child.stdout })) {
      const message = JSON.parse(line);
      if (message.progress) await progress?.(message.progress);
      else result = message;
    }
    await done;
    if (result?.error) throw new Error(result.error);
    assert.ok(result && Object.hasOwn(result,'value'));
    return result.value;
  }
  return { url, invoke, setOnline(value) { online = value; }, close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
