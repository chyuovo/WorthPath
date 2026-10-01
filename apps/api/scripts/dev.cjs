const { spawn, spawnSync } = require('node:child_process');
const tsc = require.resolve('typescript/bin/tsc');
if (spawnSync(process.execPath, [tsc], { stdio: 'inherit' }).status !== 0) process.exit(1);
const children = [
  spawn(process.execPath, [tsc, '--watch', '--preserveWatchOutput'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--watch', '--watch-path=dist', 'dist/main.js'], { stdio: 'inherit' }),
];
function stop() {
  for (const p of children) p.kill();
  process.exit();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
