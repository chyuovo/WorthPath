require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
require('reflect-metadata');
const { normalizeIcon } = require('../dist/icons');
const db = new PrismaClient();
async function main() {
  const dir = join(__dirname, '../assets/icons');
  const sources = JSON.parse(await readFile(join(dir, 'sources.json'), 'utf8'));
  // Update only deterministic built-in image IDs; preserve user uploads and financial data.
  for (const item of sources) {
    const data = await normalizeIcon(
      await readFile(join(dir, item.file)),
      item.preserveWhite === true,
    );
    const hex = createHash('sha256')
      .update('worthpath-builtin:' + item.name)
      .digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    await db.icon.upsert({
      where: { id },
      create: {
        id,
        name: item.name,
        shared: true,
        data,
        source: item.source,
        hash: createHash('sha256').update(data).digest('hex'),
      },
      update: { data, source: item.source, hash: createHash('sha256').update(data).digest('hex') },
    });
  }
  console.log(`Shared icon catalog ready: ${sources.length} icons.`);
}
main()
  .catch(() => {
    console.error('Icon seeding failed; check local database configuration.');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
