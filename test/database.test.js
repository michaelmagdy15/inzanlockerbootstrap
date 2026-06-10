const assert = require('assert');
const test = require('node:test');
const { db, dbReady } = require('../database');

test('Database tables are initialized and seeded', async (t) => {
  await dbReady;
  
  // Verify members table
  await new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(members)", [], (err, rows) => {
      if (err) return reject(err);
      assert.ok(rows.length > 0, 'members table should exist');
      const hasGender = rows.some(r => r.name === 'gender');
      assert.strictEqual(hasGender, true, 'members table should have a gender column');
      resolve();
    });
  });

  // Verify locker_assignments table
  await new Promise((resolve, reject) => {
    db.all("PRAGMA table_info(locker_assignments)", [], (err, rows) => {
      if (err) return reject(err);
      assert.ok(rows.length > 0, 'locker_assignments table should exist');
      resolve();
    });
  });

  // Verify seeded members
  await new Promise((resolve, reject) => {
    db.all("SELECT COUNT(*) as count FROM members", [], (err, rows) => {
      if (err) return reject(err);
      assert.ok(rows[0].count > 0, 'members table should be seeded with mock data');
      resolve();
    });
  });
});
