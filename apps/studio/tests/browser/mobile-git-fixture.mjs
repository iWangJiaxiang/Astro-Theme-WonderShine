import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Only Tauri IPC and the remote host are replaced. The Linux harness links the same
// libgit2 engine as iOS/Android and talks real smart HTTPS to a temporary bare Git repo.
export async function mobileGitFixture(base, appData, studio) {
  const ca = join(base, 'test-ca.pem'), key = join(base, 'test-key.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Studio test',
    '-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',ca], { stdio: 'ignore' });
  const backend = join(execFileSync('git',['--exec-path']).toString().trim(),'git-http-backend');
  let online = true, privateRemote = false;
  const token = 'fixture-token';
  const server = createServer({ key: await readFile(key), cert: await readFile(ca) }, async (request, response) => {
    const url = new URL(request.url, 'https://127.0.0.1');
    if (!online || !['/remote.git/info/refs','/remote.git/git-upload-pack','/remote.git/git-receive-pack'].includes(url.pathname)) {
      response.writeHead(503).end(); return;
    }
    if (privateRemote && request.headers.authorization !== 'Basic ' + Buffer.from('oauth2:' + token).toString('base64')) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' }).end(); return;
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
    if (result?.error) throw Object.assign(new Error(result.error.message ?? result.error), { gitDetail: result.error.gitDetail });
    assert.ok(result && Object.hasOwn(result,'value'));
    return result.value;
  }
  async function verifySync(profile) {
    const repo = join(appData,'workspaces',profile.id,'repo');
    const remote = join(base,'remote.git'), peer = join(base,'peer');
    const run = (dir, ...args) => execFileSync('git', ['-C',dir,...args], { stdio:'pipe' }).toString().trim();
    const local = () => run(repo,'rev-parse','HEAD');
    const remoteHead = () => run(remote,'rev-parse',profile.branch);
    const sync = (password = token) => invoke({ profile:{ ...profile, username:'oauth2' }, password, job:{ action:'sync',head:local() } });
    run(base,'clone','--branch',profile.branch,remote,peer);
    const advancePeer = async (text, path = 'data.toml') => {
      await writeFile(join(peer,path),text);
      run(peer,'add',path); run(peer,'-c','user.name=Fixture','-c','user.email=test@example.com','commit','-m','peer');
      run(peer,'push','origin',profile.branch);
    };
    privateRemote = true;
    const publish = (path, message) => invoke({
      profile: { ...profile, username: 'oauth2' }, password: token,
      job: { action: 'publish', head: local(), message, paths: [path] },
    });
    const publishThread = async name => {
      const path = `content/threads/${name}/index.md`;
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), name);
      assert.equal((await publish(path, name)).syncError, null);
      return path;
    };

    const first = await publishThread('first-thread');
    const firstTip = remoteHead();
    assert.equal(local(), firstTip);
    run(peer,'pull','--ff-only','origin',profile.branch);
    await advancePeer('Manual edit between publications', 'README.md');
    const manualTip = remoteHead();
    const second = await publishThread('second-thread');
    assert.equal(remoteHead(), local());
    assert.equal(run(remote, 'rev-parse', profile.branch + '^1^1'), firstTip);
    assert.equal(run(remote, 'rev-parse', profile.branch + '^2'), manualTip);
    assert.equal(run(remote, 'show', profile.branch + ':' + first), 'first-thread');
    assert.equal(run(remote, 'show', profile.branch + ':' + second), 'second-thread');
    assert.equal(run(remote, 'show', profile.branch + ':README.md'), 'Manual edit between publications');
    run(peer,'pull','--ff-only','origin',profile.branch);

    await advancePeer('title="peer"');
    const before = local();
    await assert.rejects(sync('invalid-token'));
    assert.equal(local(), before);
    assert.equal(await sync(),true);
    assert.equal(local(),remoteHead());
    assert.equal(await readFile(join(repo,'data.toml'),'utf8'),'title="peer"');
    await writeFile(join(repo,'data.toml'),'title="local"');
    const published = remoteHead();
    await invoke({ profile,job:{ action:'commit',head:local(),message:'local change',paths:['data.toml'] } });
    const pending = local();
    const hook = join(remote,'hooks','pre-receive');
    await writeFile(hook,'#!/bin/sh\nexit 1\n');
    await chmod(hook,0o755);
    await assert.rejects(sync());
    assert.equal(local(),pending); assert.equal(remoteHead(),published);
    await chmod(hook,0o644);
    assert.equal(await sync(),false); assert.equal(remoteHead(),pending);
    run(peer,'pull','--ff-only','origin',profile.branch);
    await advancePeer('title="remote config"');
    const peerTip = remoteHead();
    const path = 'data.en.toml';
    await writeFile(join(repo,path),'title="Publish from phone"');
    await chmod(hook,0o755);
    const publication = await publish(path, 'publish translation');
    assert.ok(publication.syncError);
    const merged = local();
    assert.equal(run(repo,'rev-parse','HEAD^2'),peerTip);
    assert.equal(run(repo,'show','HEAD^1:' + path),'title="Publish from phone"');
    assert.equal(remoteHead(),peerTip);
    await chmod(hook,0o644);
    assert.equal(await sync(),false);
    assert.equal(remoteHead(),merged);
    assert.equal(run(remote,'show',profile.branch + ':' + path),'title="Publish from phone"');
    assert.equal(await readFile(join(repo,'data.toml'),'utf8'),'title="remote config"');
    run(peer,'pull','--ff-only','origin',profile.branch);
    await advancePeer('title="remote change"');
    await writeFile(join(repo,'data.toml'),'title="divergence"');
    await invoke({ profile,job:{ action:'commit',head:local(),message:'divergent change',paths:['data.toml'] } });
    const divergent = local(), theirs = remoteHead();
    await assert.rejects(sync(), /合并/);
    assert.equal(local(),divergent); assert.equal(remoteHead(),theirs);
    privateRemote = false;
    console.log('PASS: libgit2 authenticated HTTPS, fast-forward, merged publication, rejected/retried push and conflicting history.');
  }
  return { url, invoke, verifySync, setOnline(value) { online = value; }, close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}
