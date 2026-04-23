const assert = require('assert/strict');
const { io: createClient } = require('socket.io-client');

const EDGE = 'http://127.0.0.1:18300';
const APP1 = 'http://127.0.0.1:18301';
const APP2 = 'http://127.0.0.1:18302';
const PROMETHEUS = 'http://127.0.0.1:19090';
const ALERTMANAGER = 'http://127.0.0.1:19093';
const GRAFANA = 'http://127.0.0.1:13170';
const MINIO = 'http://127.0.0.1:19000';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJson(url, attempts = 60) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastError = new Error(`${url} returned ${response.status}`);
      } else {
        return response.json();
      }
    } catch (error) {
      lastError = error;
    }
    await wait(1000);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function waitForStatus(url, expected = 200, attempts = 60) {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.status === expected) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await wait(1000);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function waitForSocketEvent(socket, event, predicate = () => true, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      socket.off('connect_error', onError);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
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
  let socketA = null;
  let socketB = null;

  try {
    const edgeHealth = await waitForJson(`${EDGE}/api/health`);
    const app1Health = await waitForJson(`${APP1}/api/health`);
    const app2Health = await waitForJson(`${APP2}/api/health`);

    assert.equal(edgeHealth.ok, true);
    assert.equal(app1Health.ok, true);
    assert.equal(app2Health.ok, true);

    const runtime = await waitForJson(`${EDGE}/api/runtime`);
    assert.equal(runtime.ok, true);
    assert.equal(runtime.runtime.storageBackend, 'minio');
    assert.equal(runtime.runtime.redisConnected, true);

    await waitForStatus(`${MINIO}/minio/health/ready`);
    await waitForStatus(`${PROMETHEUS}/-/ready`);
    await waitForStatus(`${ALERTMANAGER}/-/ready`);
    const grafanaHealth = await waitForJson(`${GRAFANA}/api/health`);
    assert.equal(grafanaHealth.database, 'ok');

    socketA = createClient(APP1, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      extraHeaders: { Origin: EDGE }
    });

    socketB = createClient(APP2, {
      path: '/socket.io',
      transports: ['websocket'],
      forceNew: true,
      autoConnect: false,
      extraHeaders: { Origin: EDGE }
    });

    const connectA = waitForSocketEvent(socketA, 'connect');
    const connectB = waitForSocketEvent(socketB, 'connect');
    const initA = waitForSocketEvent(socketA, 'chat:init', (payload) => payload && payload.id === 1);
    const initB = waitForSocketEvent(socketB, 'chat:init', (payload) => payload && payload.id === 1);
    socketA.connect();
    socketB.connect();
    await Promise.all([connectA, connectB, initA, initB]);

    const replicaMessage = waitForSocketEvent(
      socketB,
      'chat:message',
      (payload) => payload && payload.text === 'compose cross replica'
    );
    socketA.emit('chat:message', { id: 1, name: 'ComposeBot', text: 'compose cross replica' });
    const delivered = await replicaMessage;
    assert.equal(delivered.name, 'ComposeBot');

    const uploadForm = new FormData();
    uploadForm.append('files', new Blob(['compose upload body'], { type: 'text/plain' }), 'compose.txt');
    const uploadResponse = await fetch(`${EDGE}/api/upload?overwrite=true`, {
      method: 'POST',
      body: uploadForm
    });
    assert.equal(uploadResponse.status, 200);
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadBody.ok, true);
    assert.equal(uploadBody.files[0].name, 'compose.txt');

    const previewResponse = await fetch(`${EDGE}/preview/compose.txt`);
    assert.equal(previewResponse.status, 200);
    assert.equal(await previewResponse.text(), 'compose upload body');

    const metricsResponse = await fetch(`${EDGE}/api/metrics`);
    const metricsText = await metricsResponse.text();
    assert.match(metricsText, /sharechat_active_socket_connections/);
    assert.match(metricsText, /sharechat_chat_messages_total/);
    assert.match(metricsText, /sharechat_upload_files_total/);

    const rules = await waitForJson(`${PROMETHEUS}/api/v1/rules`);
    assert.equal(rules.status, 'success');

    console.log(JSON.stringify({ status: 'ok', message: 'share-chat compose smoke passed' }));
  } catch (error) {
    console.error(String(error && error.stack || error));
    process.exitCode = 1;
  } finally {
    if (socketA) socketA.close();
    if (socketB) socketB.close();
  }
}

main();
