const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'lockers.db');
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
    // 1. Create Users Table
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        assigned_locker INTEGER
      )
    `, (err) => {
      if (err) console.error('Error creating users table:', err.message);
      else seedUsers();
    });

    // 2. Create Access Logs Table
    db.run(`
      CREATE TABLE IF NOT EXISTS access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
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
  });
}

function seedUsers() {
  db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
    if (err) {
      console.error('Error querying users count:', err.message);
      return;
    }

    if (row.count === 0) {
      console.log('Seeding initial test users into SQLite...');
      const adminPasswordHash = bcrypt.hashSync('adminpassword', 10);
      const memberPasswordHash = bcrypt.hashSync('memberpassword', 10);

      // Insert Admin (No assigned locker, full access)
      db.run(
        'INSERT INTO users (username, password_hash, role, assigned_locker) VALUES (?, ?, ?, ?)',
        ['admin', adminPasswordHash, 'admin', null],
        (err) => {
          if (err) console.error('Failed to seed admin user:', err.message);
          else console.log('Successfully seeded administrator user ("admin" / "adminpassword").');
        }
      );

      // Insert Member (Assigned locker #14)
      db.run(
        'INSERT INTO users (username, password_hash, role, assigned_locker) VALUES (?, ?, ?, ?)',
        ['member1', memberPasswordHash, 'member', 14],
        (err) => {
          if (err) console.error('Failed to seed member1 user:', err.message);
          else console.log('Successfully seeded member user ("member1" / "memberpassword", assigned locker: 14).');
        }
      );
    }
  });
}

module.exports = db;
