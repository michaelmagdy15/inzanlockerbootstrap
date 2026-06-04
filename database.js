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
    // 1. Create Lockers Table
    db.run(`
      CREATE TABLE IF NOT EXISTS lockers (
        id INTEGER PRIMARY KEY,
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
        locker_id INTEGER NOT NULL,
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
      resolveDbReady(); // Resolve once initialization is complete
    });
  });
}

function seedLockers() {
  db.get('SELECT COUNT(*) as count FROM lockers', [], (err, row) => {
    if (err) {
      console.error('Error querying lockers count:', err.message);
      return;
    }

    const maintenanceLockers = [1, 2, 4, 8, 12, 16, 22, 23, 29, 32];

    if (row.count === 0) {
      console.log('Initializing 32 gym lockers in SQLite database...');
      
      const insertStmt = db.prepare('INSERT INTO lockers (id, status, access_token, assigned_at) VALUES (?, ?, ?, ?)');
      
      for (let i = 1; i <= 32; i++) {
        const status = maintenanceLockers.includes(i) ? 'maintenance' : 'available';
        insertStmt.run([i, status, null, null]);
      }
      
      insertStmt.finalize((err) => {
        if (err) console.error('Failed to initialize locker rows:', err.message);
        else console.log('Successfully initialized 32 lockers (Locker #1 to #32) with maintenance flags.');
      });
    }
  });
}

module.exports = { db, dbReady };
