const { db, dbReady } = require('../database');

dbReady.then(() => {
  console.log('Running daily 2 AM cleanup...');
  
  db.all(
    'SELECT * FROM locker_assignments WHERE status IN ("issued", "allocated")',
    [],
    (err, rows) => {
      if (err) {
        console.error('Error fetching assignments for cleanup:', err.message);
        process.exit(1);
      }

      if (rows.length === 0) {
        console.log('No active assignments to clean up.');
        process.exit(0);
      }

      let processed = 0;
      rows.forEach((row) => {
        db.serialize(() => {
          if (row.locker_id) {
            db.run('UPDATE lockers SET status = "available", access_token = NULL, assigned_at = NULL WHERE id = ?', [row.locker_id]);
          }
          db.run(
            'UPDATE locker_assignments SET status = "expired", vacated_at = ? WHERE id = ?',
            [Date.now(), row.id],
            (err) => {
              processed++;
              if (row.locker_id) {
                console.log(`Vacated locker ${row.locker_id} (assignment #${row.id})`);
              }
              if (processed === rows.length) {
                console.log('Daily cleanup completed successfully.');
                process.exit(0);
              }
            }
          );
        });
      });
    }
  );
});
