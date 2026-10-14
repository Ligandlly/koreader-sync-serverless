// Aliyun Function Compute adapter: persistent SQLite via sql.js (WASM).
//
// The FC built-in Node.js runtime (max nodejs20) has no `node:sqlite`, so we run
// SQLite compiled to WebAssembly. The whole database lives in memory and is
// flushed to a durable file (e.g. on a NAS mount) after every write.
//
// Because File Compute can run several instances concurrently, and because a
// memory-resident SQLite cannot coordinate between them, every write is:
//   1. guarded by a cross-process lock file (atomic O_EXCL create),
//   2. preceded by a re-read of the latest on-disk database,
//   3. persisted atomically (write temp file + rename).
// Reads re-read the file only when its mtime changed. This keeps the service
// correct even if it scales beyond a single instance.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import type { DatabaseAdapter, SqlRunResult, SqlStatement } from "../database/adapter";
import { SQL_WASM_BASE64 } from "../vendor/sql-wasm.wasm.b64";

const WASM_BINARY = Buffer.from(SQL_WASM_BASE64, "base64");
const LOCK_TIMEOUT_MS = 20_000;
const STALE_LOCK_MS = 30_000;

const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
}

let sql: SqlJsStatic | null = null;
let database: Database | null = null;
let dbPath = "";
let dbMtimeMs = -1;

function currentMtime(): number {
  try {
    return statSync(dbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function loadFromDisk(): void {
  if (!sql) throw new Error("sql.js has not been initialized");
  const bytes = existsSync(dbPath) ? new Uint8Array(readFileSync(dbPath)) : null;
  database = bytes && bytes.length > 0 ? new sql.Database(bytes) : new sql.Database();
  dbMtimeMs = currentMtime();
}

function reloadIfChanged(): void {
  const mtime = currentMtime();
  if (mtime !== dbMtimeMs) loadFromDisk();
}

function persist(): void {
  if (!database) return;
  const bytes = database.export();
  const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, dbPath);
  dbMtimeMs = currentMtime();
}

function acquireLock(): () => void {
  const lockPath = `${dbPath}.lock`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath);
        } catch {
          /* ignore */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for the SQLite write lock");
      }
      sleepMs(5 + Math.floor(Math.random() * 20));
    }
  }
}

async function ready(): Promise<void> {
  if (!sql) {
    sql = await initSqlJs({ wasmBinary: WASM_BINARY as unknown as ArrayBuffer });
  }
  if (!database) {
    mkdirSync(dirname(dbPath), { recursive: true });
    loadFromDisk();
  }
}

function normalizeParams(params: unknown[]): unknown[] {
  return params.map((value) => (value === undefined ? null : value));
}

class SqlJsStatementAdapter implements SqlStatement {
  private params: unknown[] = [];

  constructor(private readonly sqlText: string) {}

  bind(...values: unknown[]): SqlStatement {
    this.params = normalizeParams(values);
    return this;
  }

  async first<T>(): Promise<T | null> {
    await ready();
    reloadIfChanged();
    const stmt = database!.prepare(this.sqlText);
    try {
      if (this.params.length > 0) stmt.bind(this.params as never);
      if (!stmt.step()) return null;
      return stmt.getAsObject() as T;
    } finally {
      stmt.free();
    }
  }

  async all<T>(): Promise<{ results: T[] }> {
    await ready();
    reloadIfChanged();
    const stmt = database!.prepare(this.sqlText);
    const results: T[] = [];
    try {
      if (this.params.length > 0) stmt.bind(this.params as never);
      while (stmt.step()) results.push(stmt.getAsObject() as T);
    } finally {
      stmt.free();
    }
    return { results };
  }

  async run(): Promise<SqlRunResult> {
    await ready();
    const release = acquireLock();
    try {
      loadFromDisk();
      database!.run(this.sqlText, this.params as never);
      const changes = database!.getRowsModified();
      persist();
      return { meta: { changes } };
    } finally {
      release();
    }
  }
}

class SqlJsDatabaseAdapter implements DatabaseAdapter {
  prepare(sqlText: string): SqlStatement {
    return new SqlJsStatementAdapter(sqlText);
  }

  close(): void {
    database?.close();
    database = null;
  }
}

export async function createSqlJsDatabaseAdapter(sqlitePath: string): Promise<DatabaseAdapter> {
  dbPath = sqlitePath;
  await ready();
  return new SqlJsDatabaseAdapter();
}

/** Run a multi-statement SQL script (e.g. a migration file) and persist once. */
export async function execScript(sqlText: string): Promise<void> {
  await ready();
  const release = acquireLock();
  try {
    loadFromDisk();
    database!.exec(sqlText);
    persist();
  } finally {
    release();
  }
}

export async function databaseHasTable(tableName: string): Promise<boolean> {
  await ready();
  reloadIfChanged();
  const stmt = database!.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?");
  try {
    stmt.bind([tableName]);
    return stmt.step();
  } finally {
    stmt.free();
  }
}
