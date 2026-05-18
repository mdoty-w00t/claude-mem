import { Database } from 'bun:sqlite';
import { execFileSync } from 'child_process';
import { existsSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DATA_DIR, DB_PATH, ensureDir } from '../../shared/paths.js';
import { logger } from '../../utils/logger.js';
import { MigrationRunner } from './migrations/runner.js';

const SQLITE_MMAP_SIZE_BYTES = 256 * 1024 * 1024; 
const SQLITE_CACHE_SIZE_PAGES = 10_000;

export interface Migration {
  version: number;
  up: (db: Database) => void;
  down?: (db: Database) => void;
}

let dbInstance: Database | null = null;

export class ClaudeMemDatabase {
  public db: Database;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') {
      ensureDir(DATA_DIR);
    }

    this.db = new Database(dbPath, { create: true, readwrite: true });
    this.db = ClaudeMemDatabase.repairIfMalformed(dbPath, this.db);

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    const migrationRunner = new MigrationRunner(this.db);
    migrationRunner.runAllMigrations();
  }

  // bun:sqlite cannot DELETE FROM sqlite_master even with writable_schema = ON,
  // so we shell out to Python which uses a lower-level API that allows it.
  private static repairIfMalformed(dbPath: string, db: Database): Database {
    if (dbPath === ':memory:' || dbPath === '') return db;
    try {
      db.query('SELECT name FROM sqlite_master WHERE type = "table" LIMIT 1').all();
      return db;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('malformed database schema')) throw error;

      const match = message.match(/malformed database schema \(([^)]+)\)/);
      if (!match) throw error;

      const objectName = match[1];
      logger.warn('DB', `Malformed schema object "${objectName}", repairing via Python`, {});
      db.close();

      const scriptPath = join(tmpdir(), `claude-mem-repair-${Date.now()}.py`);
      try {
        writeFileSync(scriptPath, `
import sqlite3, sys
db_path = sys.argv[1]
obj_name = sys.argv[2]
c = sqlite3.connect(db_path)
c.execute('PRAGMA writable_schema = ON')
c.execute('DELETE FROM sqlite_master WHERE name = ?', (obj_name,))
c.execute('PRAGMA writable_schema = OFF')
has_sv = c.execute("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='schema_versions'").fetchone()[0]
if has_sv:
  c.execute('DELETE FROM schema_versions')
c.commit()
c.close()
`);
        execFileSync('python3', [scriptPath, dbPath, objectName], { timeout: 10000 });
        logger.info('DB', `Repaired schema object "${objectName}", migrations will re-run`, {});
      } finally {
        if (existsSync(scriptPath)) unlinkSync(scriptPath);
      }

      const newDb = new Database(dbPath, { create: true, readwrite: true });
      return ClaudeMemDatabase.repairIfMalformed(dbPath, newDb);
    }
  }

  close(): void {
    this.db.close();
  }
}

export class DatabaseManager {
  private static instance: DatabaseManager;
  private db: Database | null = null;
  private migrations: Migration[] = [];

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  registerMigration(migration: Migration): void {
    this.migrations.push(migration);
    this.migrations.sort((a, b) => a.version - b.version);
  }

  async initialize(): Promise<Database> {
    if (this.db) {
      return this.db;
    }

    ensureDir(DATA_DIR);

    this.db = new Database(DB_PATH, { create: true, readwrite: true });

    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run('PRAGMA temp_store = memory');
    this.db.run(`PRAGMA mmap_size = ${SQLITE_MMAP_SIZE_BYTES}`);
    this.db.run(`PRAGMA cache_size = ${SQLITE_CACHE_SIZE_PAGES}`);

    this.initializeSchemaVersions();

    await this.runMigrations();

    dbInstance = this.db;
    return this.db;
  }

  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return this.db;
  }

  withTransaction<T>(fn: (db: Database) => T): T {
    const db = this.getConnection();
    const transaction = db.transaction(fn);
    return transaction(db);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      dbInstance = null;
    }
  }

  private initializeSchemaVersions(): void {
    if (!this.db) return;

    this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  private async runMigrations(): Promise<void> {
    if (!this.db) return;

    const query = this.db.query('SELECT version FROM schema_versions ORDER BY version');
    const appliedVersions = query.all().map((row: any) => row.version);

    const maxApplied = appliedVersions.length > 0 ? Math.max(...appliedVersions) : 0;

    for (const migration of this.migrations) {
      if (migration.version > maxApplied) {
        logger.info('DB', `Applying migration ${migration.version}`);

        const transaction = this.db.transaction(() => {
          migration.up(this.db!);

          const insertQuery = this.db!.query('INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)');
          insertQuery.run(migration.version, new Date().toISOString());
        });

        transaction();
        logger.info('DB', `Migration ${migration.version} applied successfully`);
      }
    }
  }

  getCurrentVersion(): number {
    if (!this.db) return 0;

    const query = this.db.query('SELECT MAX(version) as version FROM schema_versions');
    const result = query.get() as { version: number } | undefined;

    return result?.version || 0;
  }
}

export function getDatabase(): Database {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call DatabaseManager.getInstance().initialize() first.');
  }
  return dbInstance;
}

export async function initializeDatabase(): Promise<Database> {
  const manager = DatabaseManager.getInstance();
  return await manager.initialize();
}

export { Database };

export { MigrationRunner } from './migrations/runner.js';

export * from './Sessions.js';
export * from './Observations.js';
export * from './Summaries.js';
export * from './Prompts.js';
export * from './Timeline.js';
export * from './Import.js';
export * from './transactions.js';