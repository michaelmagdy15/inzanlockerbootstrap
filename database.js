const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'lockers.db');

let resolveDbReady;
const dbReady = new Promise((resolve) => {
  resolveDbReady = resolve;
});

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to local SQLite database.');
    initializeDatabase();
  }
});

function initializeDatabase() {
  db.serialize(() => {
    db.all("PRAGMA table_info(lockers)", [], (err, info) => {
      let isOldSchema = false;
      if (!err && info && info.length > 0) {
        const idCol = info.find(c => c.name === 'id');
        if (idCol && idCol.type === 'INTEGER') {
          isOldSchema = true;
        }
      }

      if (isOldSchema) {
        console.log('Upgrading database schema for locker names (dropping old tables)...');
        db.run("DROP TABLE IF EXISTS lockers");
        db.run("DROP TABLE IF EXISTS access_logs");
      }

      createTablesAndSeed();
    });
  });
}

function createTablesAndSeed() {
  // 1. Create Lockers Table
  db.run(`
    CREATE TABLE IF NOT EXISTS lockers (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'available',
      access_token TEXT,
      assigned_at INTEGER
    )
  `, (err) => {
    if (err) console.error('Error creating lockers table:', err.message);
    else seedLockers();
  });

  // 2. Create Access Logs Table
  db.run(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      locker_id TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      ip_address TEXT,
      timestamp INTEGER NOT NULL,
      is_flagged INTEGER DEFAULT 0,
      flag_reason TEXT
    )
  `, (err) => {
    if (err) console.error('Error creating access_logs table:', err.message);
  });

  // 3. Create Settings Table
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `, (err) => {
    if (err) console.error('Error creating settings table:', err.message);
  });

  // 4. Create Members Table
  db.run(`
    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK(gender IN ('male', 'female')),
      status TEXT NOT NULL DEFAULT 'active'
    )
  `, (err) => {
    if (err) console.error('Error creating members table:', err.message);
    else seedMembers();
  });

  // 5. Create Locker Assignments Table
  db.run(`
    CREATE TABLE IF NOT EXISTS locker_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      member_id TEXT NOT NULL,
      locker_id TEXT,
      locker_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('issued', 'allocated', 'vacated', 'expired')),
      issued_at INTEGER NOT NULL,
      assigned_at INTEGER,
      vacated_at INTEGER,
      FOREIGN KEY (member_id) REFERENCES members(id),
      FOREIGN KEY (locker_id) REFERENCES lockers(id)
    )
  `, (err) => {
    if (err) console.error('Error creating locker_assignments table:', err.message);
    resolveDbReady(); // Resolve once initialization is complete
  });
}

function seedLockers() {
  db.get('SELECT COUNT(*) as count FROM lockers', [], (err, row) => {
    if (err) {
      console.error('Error querying lockers count:', err.message);
      return;
    }

    if (row.count === 0) {
      console.log('Seeding 68 lockers from lockers_config.json into SQLite database...');
      try {
        const fs = require('fs');
        const path = require('path');
        const lockersConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'lockers_config.json'), 'utf8'));

        const insertStmt = db.prepare('INSERT OR REPLACE INTO lockers (id, status, access_token, assigned_at) VALUES (?, ?, ?, ?)');

        lockersConfig.forEach((locker) => {
          const initialStatus = locker.status === 'maintenance' ? 'maintenance' : 'available';
          insertStmt.run([locker.name, initialStatus, null, null]);
        });

        insertStmt.finalize((err) => {
          if (err) console.error('Failed to seed lockers:', err.message);
          else console.log('Successfully seeded 68 lockers.');
        });
      } catch (e) {
        console.error('Failed to read or parse lockers_config.json:', e.message);
      }
    }
  });
}

function seedMembers() {
  db.get('SELECT COUNT(*) as count FROM members', [], (err, row) => {
    if (err) return;
    if (row.count === 0) {
      console.log('Seeding mock members into SQLite database...');
      const insertStmt = db.prepare('INSERT INTO members (id, first_name, last_name, gender, status) VALUES (?, ?, ?, ?, ?)');
      insertStmt.run(['MEM-001', 'John', 'Smith', 'male', 'active']);
      insertStmt.run(['MEM-002', 'Jane', 'Doe', 'female', 'active']);
      insertStmt.run(['MEM-003', 'Bob', 'Johnson', 'male', 'inactive']);
      insertStmt.finalize((err) => {
        if (err) console.error('Failed to seed members:', err.message);
        else console.log('Successfully seeded members.');
      });
    }
  });
}

module.exports = { db, dbReady };
