const assert = require('assert/strict');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function toBashPath(targetPath) {
  if (process.platform !== 'win32') return targetPath;
  const normalized = targetPath.replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function findBash() {
  const explicit = process.env.SHARECHAT_TEST_BASH;
  if (explicit) return explicit;

  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
      ]
    : ['/bin/bash', 'bash'];

  for (const candidate of candidates) {
    if (!candidate.includes(path.sep) && !candidate.includes('/')) return candidate;
    if (await pathExists(candidate)) return candidate;
  }

  throw new Error('bash executable not found');
}

async function writeExecutable(filePath, content) {
  await fs.writeFile(filePath, content, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('exit', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sharechat-install-'));
  const appDir = path.join(tempRoot, 'app');
  const envDir = path.join(tempRoot, 'etc');
  const systemdDir = path.join(tempRoot, 'systemd');
  const binDir = path.join(tempRoot, 'bin');
  const envFile = path.join(envDir, 'sharechat.env');
  const serviceFile = path.join(systemdDir, 'sharechat.service');
  const logFile = path.join(tempRoot, 'commands.log');
  const bashPath = await findBash();
  const serviceName = 'sharechat-ci';
  const userName = 'sharechat-ci';

  await fs.mkdir(envDir, { recursive: true });
  await fs.mkdir(systemdDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });

  await writeExecutable(path.join(binDir, 'id'), `#!/usr/bin/env bash
echo "id:$*" >> "$SHARECHAT_TEST_LOG"
exit 1
`);

  await writeExecutable(path.join(binDir, 'useradd'), `#!/usr/bin/env bash
echo "useradd:$*" >> "$SHARECHAT_TEST_LOG"
exit 0
`);

  await writeExecutable(path.join(binDir, 'chown'), `#!/usr/bin/env bash
echo "chown:$*" >> "$SHARECHAT_TEST_LOG"
exit 0
`);

  await writeExecutable(path.join(binDir, 'apt-get'), `#!/usr/bin/env bash
echo "apt-get:$*" >> "$SHARECHAT_TEST_LOG"
exit 0
`);

  await writeExecutable(path.join(binDir, 'systemctl'), `#!/usr/bin/env bash
echo "systemctl:$*" >> "$SHARECHAT_TEST_LOG"
if [ "$1" = "status" ]; then
  echo "${serviceName}.service - fake"
fi
exit 0
`);

  await writeExecutable(path.join(binDir, 'sudo'), `#!/usr/bin/env bash
echo "sudo:$*" >> "$SHARECHAT_TEST_LOG"
if [ "$1" = "-u" ]; then
  shift 2
fi
exec "$@"
`);

  await writeExecutable(path.join(binDir, 'openssl'), `#!/usr/bin/env bash
echo "openssl:$*" >> "$SHARECHAT_TEST_LOG"
KEY=
CRT=
while [[ $# -gt 0 ]]; do
  case "$1" in
    -keyout) KEY="$2"; shift 2 ;;
    -out) CRT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$KEY" ]; then
  mkdir -p "$(dirname "$KEY")"
  echo "dummy key" > "$KEY"
fi
if [ -n "$CRT" ]; then
  mkdir -p "$(dirname "$CRT")"
  echo "dummy cert" > "$CRT"
fi
exit 0
`);

  const result = await runProcess(bashPath, ['install.sh'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      SHARECHAT_APP_DIR: toBashPath(appDir),
      SHARECHAT_ENV_FILE: toBashPath(envFile),
      SHARECHAT_SERVICE_FILE: toBashPath(serviceFile),
      SHARECHAT_USER_NAME: userName,
      SHARECHAT_SERVICE_NAME: serviceName,
      SHARECHAT_NODE_BIN: '/usr/bin/node',
      SHARECHAT_INSTALL_CMD: 'test -f dist/index.js && test -f public/index.html',
      SHARECHAT_ID_BIN: toBashPath(path.join(binDir, 'id')),
      SHARECHAT_USERADD_BIN: toBashPath(path.join(binDir, 'useradd')),
      SHARECHAT_CHOWN_BIN: toBashPath(path.join(binDir, 'chown')),
      SHARECHAT_APT_GET_BIN: toBashPath(path.join(binDir, 'apt-get')),
      SHARECHAT_SUDO_BIN: toBashPath(path.join(binDir, 'sudo')),
      SHARECHAT_SYSTEMCTL_BIN: toBashPath(path.join(binDir, 'systemctl')),
      SHARECHAT_BASH_BIN: 'bash',
      SHARECHAT_OPENSSL_BIN: toBashPath(path.join(binDir, 'openssl')),
      SHARECHAT_TEST_LOG: toBashPath(logFile)
    }
  });

  try {
    assert.equal(
      result.code,
      0,
      `install.sh failed (code=${result.code})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );

    const envContent = await fs.readFile(envFile, 'utf8');
    const serviceContent = await fs.readFile(serviceFile, 'utf8');
    const logContent = await fs.readFile(logFile, 'utf8');

    assert.match(result.stdout, /Installed\. Service status:/);
    assert.match(result.stdout, new RegExp(`${serviceName}\\.service - fake`));

    assert.match(envContent, /^PORT=3000/m);
    assert.match(envContent, /^UPLOAD_RATE_LIMIT=20/m);

    assert.match(serviceContent, new RegExp(`EnvironmentFile=-${toBashPath(envFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(serviceContent, new RegExp(`WorkingDirectory=${toBashPath(appDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(serviceContent, /ExecStart=\/usr\/bin\/node dist\/index\.js/);
    assert.match(serviceContent, new RegExp(`User=${userName}`));
    assert.match(serviceContent, new RegExp(`Group=${userName}`));

    assert.match(logContent, /^id:-u /m);
    assert.match(logContent, /^useradd:-r -m /m);
    assert.match(logContent, /^chown:-R /m);
    assert.match(logContent, /^sudo:-u /m);
    assert.match(logContent, /^openssl:/m);
    assert.match(logContent, new RegExp(`^systemctl:enable ${serviceName}$`, 'm'));
    assert.match(logContent, new RegExp(`^systemctl:restart ${serviceName}$`, 'm'));

    assert.equal(await pathExists(path.join(appDir, 'dist', 'index.js')), true);
    assert.equal(await pathExists(path.join(appDir, 'public', 'index.html')), true);

    console.log('install-integration: ok');
  } catch (error) {
    console.error('install-integration: failed');
    console.error(String(error && error.stack || error));
    if (result.stdout.trim()) console.error('stdout:\n' + result.stdout.trim());
    if (result.stderr.trim()) console.error('stderr:\n' + result.stderr.trim());
    process.exitCode = 1;
  } finally {
    if (process.env.SHARECHAT_TEST_KEEP_ARTIFACTS) {
      console.log(`install-integration: keeping artifacts at ${tempRoot}`);
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main();
