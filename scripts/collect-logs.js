const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'artifacts', 'evidence');

fs.mkdirSync(outputDir, { recursive: true });

function run(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

fs.writeFileSync(path.join(outputDir, 'compose-ps.txt'), run('docker', ['compose', 'ps']));
fs.writeFileSync(path.join(outputDir, 'compose-config.txt'), run('docker', ['compose', 'config']));
fs.writeFileSync(path.join(outputDir, 'compose-logs.txt'), run('docker', ['compose', 'logs', '--no-color']));

console.log(outputDir);
