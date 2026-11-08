import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LOCAL_ID_INDEX, SCHEMA } from './schema.js';

export type Db = DatabaseSync;

const defaultPath = fileURLToPath(new URL('../../data/nubi.sqlite', import.meta.url));

/** NUBI_DB(기본 server/data/nubi.sqlite, `:memory:` 허용)를 열고 스키마를 만든다. */
export const openDb = (path: string = process.env.NUBI_DB ?? defaultPath): Db => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  const columns = db.prepare('PRAGMA table_info(trips)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'local_id')) db.exec('ALTER TABLE trips ADD COLUMN local_id TEXT');
  db.exec(LOCAL_ID_INDEX);
  return db;
};
