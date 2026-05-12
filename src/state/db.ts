import Database from "better-sqlite3"

export type DB = Database.Database

export function openDb(dbPath: string): DB {
  const db = new Database(dbPath)
  db.pragma("journal_mode = WAL")
  db.pragma("synchronous = NORMAL")
  return db
}

