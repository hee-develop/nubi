import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const defaultPath = fileURLToPath(new URL('../../data/nubi.sqlite', import.meta.url));

/** NUBI_DB(기본 server/data/nubi.sqlite, `:memory:` 허용)를 열고 스키마를 만든다. */
export const openDb = (path: string = process.env.NUBI_DB ?? defaultPath): Db => {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  return db;
};
