import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Every scenario owns its random database; never run against the configured business database.
test(
  'real migrations initialize, recover failed 005, preserve data and reject untracked schemas',
  { skip: process.env.TEST_ISOLATED !== 'true' },
  async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const db = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    const directory = resolve('prisma/migrations');
    const expected = readdirSync(directory, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const names: string[] = [];
    const run = (database: string, raw = false) => {
      const target = new URL(url);
      target.pathname = '/' + database;
      return spawnSync(
        process.execPath,
        raw
          ? [require.resolve('prisma/build/index.js'), 'migrate', 'deploy']
          : [resolve('scripts/database.cjs'), 'deploy'],
        { env: { ...process.env, DATABASE_URL: target.toString() }, encoding: 'utf8' },
      );
    };
    const create = async () => {
      const name = 'wp_test_migrations_' + randomBytes(8).toString('hex');
      await db.query('CREATE DATABASE `' + name + '`');
      names.push(name);
      await db.query('USE `' + name + '`');
      return name;
    };
    const verify = async () => {
      const [rows] = await db.query<any[]>(
        'SELECT migration_name, checksum FROM `_prisma_migrations` WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      );
      assert.deepEqual(
        rows.map((r) => r.migration_name),
        expected,
      );
      for (const row of rows)
        assert.equal(
          row.checksum,
          createHash('sha256')
            .update(readFileSync(join(directory, row.migration_name, 'migration.sql')))
            .digest('hex'),
        );
      const [columns] = await db.query<any[]>("SHOW COLUMNS FROM `Icon` LIKE 'source'");
      assert.equal(columns.length, 0);
    };
    try {
      const fresh = await create();
      assert.equal(run(fresh).status, 0, 'empty database deploy must succeed');
      await verify();
      await db.query('CREATE TABLE `migration_test_marker` (`value` INT NOT NULL)');
      await db.query('INSERT INTO `migration_test_marker` VALUES (42)');
      const [before] = await db.query('SELECT * FROM `_prisma_migrations` ORDER BY id');
      assert.equal(run(fresh).status, 0, 'repeat deploy must succeed');
      const [after] = await db.query('SELECT * FROM `_prisma_migrations` ORDER BY id');
      assert.deepEqual(after, before, 'existing migration history must stay unchanged');
      const [marker] = await db.query<any[]>('SELECT * FROM `migration_test_marker`');
      assert.equal(marker[0].value, 42);

      const failed = await create();
      const broken = run(failed, true);
      assert.notEqual(broken.status, 0);
      assert.match(broken.stdout + broken.stderr, /1824/);
      assert.equal(run(failed).status, 0, 'known failed 005 on an empty database must recover');
      await verify();
      const [rolled] = await db.query<any[]>(
        "SELECT * FROM `_prisma_migrations` WHERE migration_name='005_account_icons' AND rolled_back_at IS NOT NULL",
      );
      assert.equal(rolled.length, 1);

      const untracked = await create();
      await db.query('CREATE TABLE `existing_data` (`value` INT NOT NULL)');
      await db.query('INSERT INTO `existing_data` VALUES (7)');
      assert.notEqual(run(untracked).status, 0, 'untracked existing schema must be refused');
      const [preserved] = await db.query<any[]>('SELECT * FROM `existing_data`');
      assert.equal(preserved[0].value, 7);
    } finally {
      for (const name of names) await db.query('DROP DATABASE `' + name + '`');
      await db.end();
    }
  },
);
