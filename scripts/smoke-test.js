const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const { io: createClient } = require('socket.io-client');

const ROOT = path.resolve(__dirname, '..');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestHttps(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      rejectUnauthorized: false
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        resolve({
          response: {
            status: response.statusCode || 0,
            headers: {
              get(name) {
                const value = response.headers[String(name).toLowerCase()];
                if (Array.isArray(value)) return value.join('; ');
                return value || '';
              }
            }
          },
          body
        });
      });
    });

    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function waitForHealth(baseUrl, attempts = 40) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return response.json();
      }
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError || new Error('health check failed');
}

async function waitForHttpsHealth(baseUrl, attempts = 40) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const { response, body } = await requestHttps(`${baseUrl}/api/health`);
      if (response.status === 200) {
        return JSON.parse(body);
      }
      lastError = new Error(`https health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw lastError || new Error('https health check failed');
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    wait(5000).then(() => {
      child.kill('SIGKILL');
    })
  ]);
}

async function waitForExit(child, timeoutMs = 5000) {
  if (!child) return null;
  if (child.exitCode != null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return Promise.race([
    new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    wait(timeoutMs).then(() => null)
  ]);
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  return { response, body };
}

async function waitForSocketEvent(socket, event, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
      reject(new Error(`socket timeout waiting for ${event}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
    }

    function onEvent(payload) {
      if (!predicate(payload)) return;
      cleanup();
      resolve(payload);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    socket.on(event, onEvent);
    socket.on('connect_error', onError);
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sharechat-smoke-'));
  const uploadsDir = path.join(tempRoot, 'uploads');
  const dataDir = path.join(tempRoot, 'data');
  const allowedIpsFile = path.join(tempRoot, 'allowed_ips.txt');
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(allowedIpsFile, '', 'utf8');

  let child = null;
  let socket = null;
  let stdout = '';
  let stderr = '';

  const baseEnv = {
    ...process.env,
    PORT: String(port),
    PUBLIC_ORIGIN: baseUrl,
    UPLOADS_DIR: uploadsDir,
    DATA_DIR: dataDir,
    ALLOWED_IPS_FILE: allowedIpsFile
  };

  const startServer = async (envOverrides = {}, waitFor = () => waitForHealth(baseUrl)) => {
    stdout = '';
    stderr = '';
    child = spawn(process.execPath, [path.join('dist', 'index.js')], {
      cwd: ROOT,
      env: { ...baseEnv, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    await waitFor();
  };

  const expectStartupFailure = async (envOverrides = {}) => {
    let failureStdout = '';
    let failureStderr = '';
    const failedChild = spawn(process.execPath, [path.join('dist', 'index.js')], {
      cwd: ROOT,
      env: { ...baseEnv, ...envOverrides },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    failedChild.stdout.on('data', (chunk) => {
      failureStdout += String(chunk);
    });
    failedChild.stderr.on('data', (chunk) => {
      failureStderr += String(chunk);
    });

    for (let index = 0; index < 12; index += 1) {
      if (failedChild.exitCode != null) break;
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) {
          await stopServer(failedChild);
          throw new Error('server unexpectedly started');
        }
      } catch {}
      await wait(250);
    }

    const exit = await waitForExit(failedChild, 2000);
    if (!exit) {
      await stopServer(failedChild);
      throw new Error('server did not exit after startup failure');
    }

    return {
      exit,
      stdout: failureStdout,
      stderr: failureStderr
    };
  };

  try {
    const httpsBaseUrl = `https://localhost:${port}`;
    const tlsKeyPath = 'scripts/fixtures/localhost.key';
    const tlsCertPath = 'scripts/fixtures/localhost.crt';

    await startServer();

    const health = await requestJson(baseUrl, '/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);

    const rootPage = await fetch(`${baseUrl}/`);
    assert.equal(rootPage.status, 200);
    assert.match(await rootPage.text(), /ShareChat/);

    const styleResponse = await fetch(`${baseUrl}/public/style.css`);
    assert.equal(styleResponse.status, 200);
    assert.match(styleResponse.headers.get('content-type') || '', /text\/css/);

    const blockedOrigin = await requestJson(baseUrl, '/api/files', {
      headers: { Origin: 'https://evil.example' }
    });
    assert.equal(blockedOrigin.response.status, 403);

    socket = createClient(baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      extraHeaders: { Origin: baseUrl }
    });

    const connectPromise = waitForSocketEvent(socket, 'connect');
    const initialChatPromise = waitForSocketEvent(socket, 'chat:init', (payload) => payload && payload.id === 1);
    socket.connect();
    await connectPromise;
    const initialChat = await initialChatPromise;
    assert.equal(initialChat.id, 1);

    const socketMessagePromise = waitForSocketEvent(socket, 'chat:message', (payload) => payload && payload.text === 'socket smoke');
    const socketNamesPromise = waitForSocketEvent(
      socket,
      'chat:names',
      (payload) => payload && payload.id === 1 && Array.isArray(payload.names) && payload.names.includes('SmokeBot')
    );
    socket.emit('chat:message', { id: 1, name: 'SmokeBot', text: 'socket smoke' });
    const socketMessage = await socketMessagePromise;
    assert.equal(socketMessage.name, 'SmokeBot');
    const socketNames = await socketNamesPromise;
    assert.ok(socketNames.names.includes('SmokeBot'));

    const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6Nn6kAAAAASUVORK5CYII=';
    const socketImagePromise = waitForSocketEvent(
      socket,
      'chat:message',
      (payload) => payload && payload.image && payload.image.startsWith('/uploads/chat-image-')
    );
    socket.emit('chat:message', { id: 1, name: 'SmokeBot', image: onePixelPng });
    const socketImageMessage = await socketImagePromise;
    const chatImageName = decodeURIComponent(socketImageMessage.image.split('/').pop());
    const chatImagePath = path.join(uploadsDir, chatImageName);
    await fs.access(chatImagePath);

    const clearChat = await fetch(`${baseUrl}/api/chats/1/messages`, { method: 'DELETE' });
    assert.equal(clearChat.status, 204);
    await wait(1500);
    await assert.rejects(() => fs.access(chatImagePath));

    const initialFiles = await requestJson(baseUrl, '/api/files');
    assert.equal(initialFiles.response.status, 200);
    assert.equal(initialFiles.body.ok, true);
    assert.deepEqual(initialFiles.body.files, []);

    const uploadForm = new FormData();
    uploadForm.append('files', new Blob(['first file body'], { type: 'text/plain' }), 'smoke.txt');
    const uploadResponse = await requestJson(baseUrl, '/api/upload?overwrite=true', {
      method: 'POST',
      body: uploadForm
    });
    assert.equal(uploadResponse.response.status, 200);
    assert.equal(uploadResponse.body.ok, true);
    assert.equal(uploadResponse.body.files[0].name, 'smoke.txt');

    const previewFirst = await fetch(`${baseUrl}/preview/smoke.txt`).then((response) => response.text());
    assert.equal(previewFirst, 'first file body');

    const overwriteForm = new FormData();
    overwriteForm.append('files', new Blob(['second file body'], { type: 'text/plain' }), 'smoke.txt');
    const overwriteResponse = await requestJson(baseUrl, '/api/upload?overwrite=true', {
      method: 'POST',
      body: overwriteForm
    });
    assert.equal(overwriteResponse.response.status, 200);

    const previewSecond = await fetch(`${baseUrl}/preview/smoke.txt`).then((response) => response.text());
    assert.equal(previewSecond, 'second file body');

    const listedFiles = await requestJson(baseUrl, '/api/files');
    assert.equal(listedFiles.body.files.length, 1);
    assert.equal(listedFiles.body.files[0].name, 'smoke.txt');

    const deleteFile = await requestJson(baseUrl, '/api/files/smoke.txt', { method: 'DELETE' });
    assert.equal(deleteFile.response.status, 200);

    const afterDeleteFiles = await requestJson(baseUrl, '/api/files');
    assert.deepEqual(afterDeleteFiles.body.files, []);

    const createChat = await requestJson(baseUrl, '/api/chats', { method: 'POST' });
    assert.equal(createChat.response.status, 201);
    assert.equal(createChat.body.ok, true);
    assert.ok(Number.isInteger(createChat.body.id));
    await wait(800);

    await stopServer(child);
    child = null;

    await startServer();

    const chatsAfterRestart = await requestJson(baseUrl, '/api/chats');
    assert.equal(chatsAfterRestart.response.status, 200);
    assert.ok(chatsAfterRestart.body.chats.includes(createChat.body.id));

    const deleteChat = await fetch(`${baseUrl}/api/chats/${createChat.body.id}`, { method: 'DELETE' });
    assert.equal(deleteChat.status, 204);

    const chatStorePath = path.join(dataDir, 'chats.json');
    const chatStoreRaw = await fs.readFile(chatStorePath, 'utf8');
    const chatStore = JSON.parse(chatStoreRaw);
    assert.ok(Array.isArray(chatStore.chats));

    if (socket) {
      socket.close();
      socket = null;
    }

    await stopServer(child);
    child = null;

    await startServer({ AUTH_INVITE_CODES: 'alpha' });

    const deniedFiles = await requestJson(baseUrl, '/api/files');
    assert.equal(deniedFiles.response.status, 401);

    const invitedRoot = await fetch(`${baseUrl}/?invite=alpha`, {
      headers: { Accept: 'text/html' }
    });
    assert.equal(invitedRoot.status, 200);
    const inviteCookieHeader = invitedRoot.headers.get('set-cookie') || '';
    assert.match(inviteCookieHeader, /sharechat_invite=/);
    assert.match(inviteCookieHeader, /HttpOnly/i);
    const inviteCookie = inviteCookieHeader.split(';')[0];

    const invitedFiles = await requestJson(baseUrl, '/api/files', {
      headers: { Cookie: inviteCookie }
    });
    assert.equal(invitedFiles.response.status, 200);
    assert.equal(invitedFiles.body.ok, true);

    socket = createClient(baseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      extraHeaders: {
        Origin: baseUrl,
        Cookie: inviteCookie
      }
    });

    const invitedConnect = waitForSocketEvent(socket, 'connect');
    socket.connect();
    await invitedConnect;
    socket.close();
    socket = null;

    await stopServer(child);
    child = null;

    await fs.writeFile(allowedIpsFile, '192.0.2.1\n', 'utf8');
    await startServer();

    const blockedPage = await fetch(`${baseUrl}/`, {
      headers: { Accept: 'text/html' }
    });
    assert.equal(blockedPage.status, 403);
    assert.match(await blockedPage.text(), /Доступ ограничен/);

    const blockedIpInfo = await requestJson(baseUrl, '/api/ip');
    assert.equal(blockedIpInfo.response.status, 200);
    assert.equal(blockedIpInfo.body.ok, true);
    assert.equal(typeof blockedIpInfo.body.ip, 'string');

    await stopServer(child);
    child = null;
    await fs.writeFile(allowedIpsFile, '', 'utf8');

    await startServer({
      PUBLIC_ORIGIN: httpsBaseUrl,
      HTTPS_KEY_FILE: tlsKeyPath,
      HTTPS_CERT_FILE: tlsCertPath,
      AUTH_INVITE_CODES: 'bravo'
    }, () => waitForHttpsHealth(httpsBaseUrl));

    const httpsInvitedRoot = await requestHttps(`${httpsBaseUrl}/?invite=bravo`, {
      headers: { Accept: 'text/html' }
    });
    assert.equal(httpsInvitedRoot.response.status, 200);
    const httpsCookieHeader = httpsInvitedRoot.response.headers.get('set-cookie') || '';
    assert.match(httpsCookieHeader, /sharechat_invite=/);
    assert.match(httpsCookieHeader, /HttpOnly/i);
    assert.match(httpsCookieHeader, /Secure/i);
    const httpsInviteCookie = httpsCookieHeader.split(';')[0];

    const httpsHealth = await requestHttps(`${httpsBaseUrl}/api/health`, {
      headers: { Cookie: httpsInviteCookie }
    });
    assert.equal(httpsHealth.response.status, 200);
    assert.equal(JSON.parse(httpsHealth.body).ok, true);

    socket = createClient(httpsBaseUrl, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      secure: true,
      rejectUnauthorized: false,
      extraHeaders: {
        Origin: httpsBaseUrl,
        Cookie: httpsInviteCookie
      }
    });

    const httpsConnect = waitForSocketEvent(socket, 'connect');
    socket.connect();
    await httpsConnect;
    socket.close();
    socket = null;

    await stopServer(child);
    child = null;

    const failedTlsStart = await expectStartupFailure({
      HTTPS_KEY_FILE: 'missing.key',
      HTTPS_CERT_FILE: 'missing.crt'
    });
    assert.notEqual(failedTlsStart.exit.code, 0);
    assert.match(
      `${failedTlsStart.stdout}\n${failedTlsStart.stderr}`,
      /https option load failed|ENOENT|server\.start_failed/i
    );

    console.log('smoke-test: ok');
  } catch (error) {
    console.error('smoke-test: failed');
    console.error(String(error && error.stack || error));
    if (stdout.trim()) console.error('stdout:\n' + stdout.trim());
    if (stderr.trim()) console.error('stderr:\n' + stderr.trim());
    process.exitCode = 1;
  } finally {
    if (socket) socket.close();
    await stopServer(child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main();
