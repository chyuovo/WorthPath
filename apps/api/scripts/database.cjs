const { spawnSync } = require('node:child_process');
const command = process.argv[2];
if (!['deploy', 'status'].includes(command)) process.exit(1);
const p = spawnSync(
  process.execPath,
  [require.resolve('prisma/build/index.js'), 'migrate', command],
  { encoding: 'utf8' },
);
// Prisma datasource lines can expose local connection metadata; omit them.
const output = (p.stdout || '')
  .split(/\r?\n/)
  .filter((s) => !s.startsWith('Datasource ') && !s.includes('Environment variables'))
  .join('\n');
if (p.status === 0) console.log(output);
else
  console.error(
    'Database migration command failed. Check local database access and migration compatibility. No reset was performed.',
  );
process.exitCode = p.status || 0;
