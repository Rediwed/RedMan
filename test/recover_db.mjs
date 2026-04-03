#!/usr/bin/env node

// RedMan Database Recovery Tool
// Recovers the database from backup files stored in SSD backup destinations,
// or rebuilds config metadata from .versions/ filesystem manifests.
//
// Usage:
//   node test/recover_db.mjs --scan /path/to/dest1 /path/to/dest2
//   node test/recover_db.mjs --restore /path/to/dest/.versions/_db_backups/redman-2024-05-10T14-32-15.db
//   node test/recover_db.mjs --rebuild /path/to/dest1 /path/to/dest2

import { readdir, readFile, stat, copyFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_BACKUP_DIR = '_db_backups';

// ── Helpers ──

function parseTimestamp(ts) {
  const iso = ts.replace(/T(\d{2})-(\d{2})-(\d{2})$/, 'T$1:$2:$3');
  return new Date(iso);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Scan ──

async function scanDestination(destPath) {
  const absPath = resolve(destPath);
  console.log(`\n📂 Scanning: ${absPath}`);

  if (!existsSync(absPath)) {
    console.log('   ❌ Path does not exist');
    return;
  }

  // Check for DB backups
  const backupDir = join(absPath, '.versions', DB_BACKUP_DIR);
  if (existsSync(backupDir)) {
    const files = await readdir(backupDir);
    const dbFiles = files.filter(f => f.startsWith('redman-') && f.endsWith('.db')).sort().reverse();
    if (dbFiles.length > 0) {
      console.log(`\n   💾 Database backups found (${dbFiles.length}):`);
      for (const f of dbFiles) {
        const info = await stat(join(backupDir, f));
        console.log(`      ${f}  (${formatSize(info.size)}, ${info.mtime.toLocaleString()})`);
      }
      console.log(`\n   → To restore: node test/recover_db.mjs --restore "${join(backupDir, dbFiles[0])}"`);
    }
  } else {
    console.log('   ⚠️  No database backups found in .versions/_db_backups/');
  }

  // Scan version snapshots
  const versionsDir = join(absPath, '.versions');
  if (!existsSync(versionsDir)) {
    console.log('   ⚠️  No .versions directory found');
    return;
  }

  const entries = await readdir(versionsDir);
  const snapshots = entries.filter(e => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e)).sort();

  if (snapshots.length === 0) {
    console.log('   ⚠️  No version snapshots found');
    return;
  }

  console.log(`\n   📸 Version snapshots: ${snapshots.length}`);
  console.log(`      Oldest: ${snapshots[0]} (${parseTimestamp(snapshots[0]).toLocaleString()})`);
  console.log(`      Newest: ${snapshots[snapshots.length - 1]} (${parseTimestamp(snapshots[snapshots.length - 1]).toLocaleString()})`);

  let totalFiles = 0, deltaFiles = 0;
  for (const ts of snapshots) {
    try {
      const raw = await readFile(join(versionsDir, ts, '_manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw);
      if (manifest.files) {
        for (const [, meta] of Object.entries(manifest.files)) {
          totalFiles++;
          if (meta.type === 'delta') deltaFiles++;
        }
      }
    } catch {}
  }

  console.log(`      Files tracked: ${totalFiles} (${deltaFiles} deltas, ${totalFiles - deltaFiles} full)`);

  // Try to infer config settings
  console.log('\n   🔧 Inferred config for --rebuild:');
  console.log(`      dest_path: "${absPath}"`);
  console.log(`      versioning_enabled: true`);
  console.log(`      delta_versioning: ${deltaFiles > 0}`);
  console.log(`      snapshots span: ~${Math.ceil((parseTimestamp(snapshots[snapshots.length - 1]) - parseTimestamp(snapshots[0])) / (1000 * 60 * 60 * 24))} days`);
}

// ── Restore from backup ──

async function restoreFromBackup(backupPath) {
  const absPath = resolve(backupPath);
  console.log(`\n💾 Restoring database from: ${absPath}`);

  if (!existsSync(absPath)) {
    console.error('❌ Backup file not found');
    process.exit(1);
  }

  // Validate SQLite header
  const { open } = await import('fs/promises');
  const fh = await open(absPath, 'r');
  const header = Buffer.alloc(16);
  await fh.read(header, 0, 16, 0);
  await fh.close();

  if (header.toString('utf-8', 0, 15) !== 'SQLite format 3') {
    console.error('❌ File is not a valid SQLite database');
    process.exit(1);
  }

  const info = await stat(absPath);
  console.log(`   Size: ${formatSize(info.size)}`);
  console.log(`   Modified: ${info.mtime.toLocaleString()}`);

  const dbPath = process.env.DB_PATH || join(__dirname, '..', 'app', 'backend', 'data', 'redman.db');
  console.log(`\n   Target: ${dbPath}`);

  // Save existing DB as safety net
  if (existsSync(dbPath)) {
    const safeCopy = dbPath.replace('.db', `-pre-restore-${Date.now()}.db`);
    await copyFile(dbPath, safeCopy);
    console.log(`   Saved current DB as: ${safeCopy}`);
  }

  await copyFile(absPath, dbPath);
  console.log('\n✅ Database restored successfully!');
  console.log('   Restart RedMan for changes to take effect.');
}

// ── Rebuild from filesystem ──

async function rebuildFromFilesystem(destPaths) {
  console.log('\n🔄 Rebuilding config metadata from filesystem...');
  console.log('   This creates minimal ssd_backup_configs entries from .versions/ data.\n');

  const dbPath = process.env.DB_PATH || join(__dirname, '..', 'app', 'backend', 'data', 'redman.db');

  // Dynamic import better-sqlite3
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    console.error('❌ better-sqlite3 not available. Run: cd app && npm install');
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure the table exists (DB might be empty/fresh)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ssd_backup_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      source_path TEXT NOT NULL,
      dest_path TEXT NOT NULL,
      cron_expression TEXT NOT NULL DEFAULT '0 * * * *',
      versioning_enabled INTEGER NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      delta_versioning INTEGER NOT NULL DEFAULT 0,
      delta_threshold INTEGER NOT NULL DEFAULT 50,
      delta_max_chain INTEGER NOT NULL DEFAULT 10,
      delta_keyframe_days INTEGER NOT NULL DEFAULT 7,
      retention_policy TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      notify_on_success INTEGER NOT NULL DEFAULT 1,
      notify_on_failure INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const insert = db.prepare(`
    INSERT INTO ssd_backup_configs (name, source_path, dest_path, versioning_enabled, delta_versioning, enabled)
    VALUES (?, ?, ?, 1, ?, 0)
  `);

  for (const destPath of destPaths) {
    const absPath = resolve(destPath);
    const versionsDir = join(absPath, '.versions');

    if (!existsSync(versionsDir)) {
      console.log(`   ⚠️  Skipping ${absPath} — no .versions directory`);
      continue;
    }

    // Check if config already exists for this dest
    const existing = db.prepare('SELECT id FROM ssd_backup_configs WHERE dest_path = ?').get(absPath);
    if (existing) {
      console.log(`   ⏭️  Config already exists for ${absPath} (id: ${existing.id})`);
      continue;
    }

    // Detect delta usage
    const entries = await readdir(versionsDir);
    const snapshots = entries.filter(e => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(e));
    let hasDelta = false;
    for (const ts of snapshots) {
      try {
        const raw = await readFile(join(versionsDir, ts, '_manifest.json'), 'utf-8');
        const manifest = JSON.parse(raw);
        if (manifest.files && Object.values(manifest.files).some(m => m.type === 'delta')) {
          hasDelta = true;
          break;
        }
      } catch {}
    }

    const name = `Recovered — ${absPath.split('/').pop()}`;
    const sourcePlaceholder = '*** SET SOURCE PATH ***';

    insert.run(name, sourcePlaceholder, absPath, hasDelta ? 1 : 0);
    const id = db.prepare('SELECT last_insert_rowid() as id').get().id;

    console.log(`   ✅ Created config #${id}: "${name}"`);
    console.log(`      dest_path: ${absPath}`);
    console.log(`      delta_versioning: ${hasDelta}`);
    console.log(`      ⚠️  source_path needs to be set manually!`);
    console.log(`      ⚠️  Created DISABLED — enable after reviewing settings\n`);
  }

  db.close();
  console.log('Done. Review configs in the UI and set source paths before enabling.');
}

// ── CLI ──

const args = process.argv.slice(2);
const command = args[0];
const paths = args.slice(1);

if (!command || command === '--help') {
  console.log(`
RedMan Database Recovery Tool

Usage:
  node test/recover_db.mjs --scan <dest_path> [dest_path...]
    Scan backup destinations for DB backups and version history.

  node test/recover_db.mjs --restore <backup_file_path>
    Restore the RedMan database from a backup file.
    The backup files are located in <dest_path>/.versions/_db_backups/

  node test/recover_db.mjs --rebuild <dest_path> [dest_path...]
    Rebuild minimal SSD backup configs from .versions/ filesystem data.
    Creates disabled configs — review and set source paths before enabling.

Environment:
  DB_PATH    Override the database file location (default: app/backend/data/redman.db)
`);
  process.exit(0);
}

switch (command) {
  case '--scan':
    if (paths.length === 0) {
      console.error('❌ Provide at least one destination path to scan');
      process.exit(1);
    }
    for (const p of paths) await scanDestination(p);
    break;

  case '--restore':
    if (paths.length !== 1) {
      console.error('❌ Provide exactly one backup file path');
      process.exit(1);
    }
    await restoreFromBackup(paths[0]);
    break;

  case '--rebuild':
    if (paths.length === 0) {
      console.error('❌ Provide at least one destination path');
      process.exit(1);
    }
    await rebuildFromFilesystem(paths);
    break;

  default:
    console.error(`❌ Unknown command: ${command}`);
    console.error('Run with --help for usage');
    process.exit(1);
}
