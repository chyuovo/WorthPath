require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const db = new PrismaClient();
(async () => {
  const tables = await db.$queryRaw`SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`;
  const columns =
    await db.$queryRaw`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION`;
  if (tables.some((t) => !t.TABLE_COMMENT) || columns.some((c) => !c.COLUMN_COMMENT))
    throw Error('Database tables or columns are missing comments.');
  mkdirSync(resolve(__dirname, '../../../docs/evidence'), { recursive: true });
  writeFileSync(
    resolve(__dirname, '../../../docs/evidence/database-comments.json'),
    JSON.stringify(
      {
        tableCount: tables.length,
        columnCount: columns.length,
        tables,
        columns,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Database comments verified: ${tables.length} tables, ${columns.length} columns.`);
})()
  .catch(() => {
    console.error('Comment verification failed. Check database access and table/column comments.');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
