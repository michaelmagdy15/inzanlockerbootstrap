# Gym Locker Automation System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement database migrations, PassKit ticket issuance, locker room terminal engine, auto-vacate webhook, and a geofenced member backup portal for gym locker automation.

**Architecture:** Extend the existing Express/SQLite middleware server with member tables and assignments tracking. Allocate physical lockers dynamically on first scan using a Python-based stdin parser at local terminals, and handle gym-exit turnstile checks to release lockers.

**Tech Stack:** Node.js (Express), SQLite/PostgreSQL, Python 3, MQTT, PassKit-Generator (Apple Wallet passes), Geolocation API.

---

## Task 1: Database Schema & Seeding (SQLite/PostgreSQL Migrations)

**Files:**
- Modify: `h:/inzanlockerbootstrap/database.js`
- Create: `h:/inzanlockerbootstrap/test/database.test.js`
- Create: `h:/inzanlockerbootstrap/migrations/001_init_gym_locker.sql`

**Step 1: Write the failing test**

Create `test/database.test.js` to assert the database tables are created correctly:

```javascript
// h:/inzanlockerbootstrap/test/database.test.js
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
```

**Step 2: Run test to verify it fails**

Run: `node --test test/database.test.js`
Expected: FAIL with "database table members does not exist" or similar schema error.

**Step 3: Write minimal implementation**

Modify `database.js` to declare and execute the SQL migrations for SQLite:

```javascript
// h:/inzanlockerbootstrap/database.js
// Modify createTablesAndSeed() to add members and locker_assignments:

function createTablesAndSeed() {
  // 1. Create Lockers Table (Existing)
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

  // 2. Create Access Logs Table (Existing)
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

  // 3. Create Settings Table (Existing)
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `, (err) => {
    if (err) console.error('Error creating settings table:', err.message);
  });

  // 4. Create Members Table (New)
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

  // 5. Create Locker Assignments Table (New)
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
    resolveDbReady(); // Resolve once all initialization is complete
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
```

Create PostgreSQL migration file `migrations/001_init_gym_locker.sql` for future SQL database extensions:

```sql
-- h:/inzanlockerbootstrap/migrations/001_init_gym_locker.sql
CREATE TABLE IF NOT EXISTS members (
  id VARCHAR(50) PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  gender VARCHAR(10) NOT NULL CHECK(gender IN ('male', 'female')),
  status VARCHAR(20) NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS lockers (
  id VARCHAR(10) PRIMARY KEY,
  status VARCHAR(20) NOT NULL DEFAULT 'available',
  access_token VARCHAR(64),
  assigned_at BIGINT
);

CREATE TABLE IF NOT EXISTS locker_assignments (
  id SERIAL PRIMARY KEY,
  member_id VARCHAR(50) NOT NULL REFERENCES members(id),
  locker_id VARCHAR(10) REFERENCES lockers(id),
  locker_token VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL CHECK(status IN ('issued', 'allocated', 'vacated', 'expired')),
  issued_at BIGINT NOT NULL,
  assigned_at BIGINT,
  vacated_at BIGINT
);
```

**Step 4: Run test to verify it passes**

Run: `node --test test/database.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add database.js test/database.test.js migrations/001_init_gym_locker.sql
git commit -m "feat: add members and locker_assignments schema migrations"
```

---

## Task 2: Pass Generation & Issuance Engine

**Files:**
- Modify: `h:/inzanlockerbootstrap/server.js`
- Create: `h:/inzanlockerbootstrap/public/member.html`
- Create: `h:/inzanlockerbootstrap/test/pass_issuance.test.js`

**Step 1: Write the failing test**

Create `test/pass_issuance.test.js`:

```javascript
// h:/inzanlockerbootstrap/test/pass_issuance.test.js
const assert = require('assert');
const test = require('node:test');

test('Pass Issuance APIs', async (t) => {
  // Test invalid credentials
  const resInvalid = await fetch('http://localhost:3000/api/member/issue-pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-999', lastName: 'Wrong' })
  });
  assert.strictEqual(resInvalid.status, 401);

  // Test valid credentials
  const resValid = await fetch('http://localhost:3000/api/member/issue-pass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Smith' })
  });
  assert.strictEqual(resValid.status, 200);
  const data = await resValid.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.locker_token, 'Should return a locker_token');
});
```

**Step 2: Run test to verify it fails**

Ensure server is running: `node server.js`
Run: `node --test test/pass_issuance.test.js`
Expected: FAIL with connection errors or 404 Route Not Found.

**Step 3: Write minimal implementation**

Modify `server.js` to add the pass issuance and Wallet pass generation endpoints:

```javascript
// h:/inzanlockerbootstrap/server.js
// Insert near client endpoints:

// POST /api/member/issue-pass
app.post('/api/member/issue-pass', (req, res) => {
  const { memberId, lastName } = req.body;
  if (!memberId || !lastName) {
    return res.status(400).json({ success: false, message: 'Member ID and Last Name are required.' });
  }

  db.get(
    'SELECT * FROM members WHERE id = ? AND LOWER(last_name) = ? AND status = "active"',
    [memberId.trim(), lastName.trim().toLowerCase()],
    (err, member) => {
      if (err || !member) {
        return res.status(401).json({ success: false, message: 'Invalid or inactive Member credentials.' });
      }

      // Look up existing active pass
      db.get(
        'SELECT * FROM locker_assignments WHERE member_id = ? AND status IN ("issued", "allocated") LIMIT 1',
        [member.id],
        (err, existing) => {
          if (!err && existing) {
            const twelveHours = 12 * 60 * 60 * 1000;
            if (Date.now() - existing.issued_at < twelveHours) {
              return res.json({
                success: true,
                message: 'Active pass retrieved.',
                locker_token: existing.locker_token,
                status: existing.status
              });
            } else {
              db.run('UPDATE locker_assignments SET status = "expired" WHERE id = ?', [existing.id]);
            }
          }

          const token = crypto.randomUUID();
          db.run(
            'INSERT INTO locker_assignments (member_id, locker_token, status, issued_at) VALUES (?, ?, "issued", ?)',
            [member.id, token, Date.now()],
            function(err) {
              if (err) {
                return res.status(500).json({ success: false, message: 'Database error issuing locker token.' });
              }
              return res.json({
                success: true,
                message: 'Locker token issued successfully.',
                locker_token: token,
                status: 'issued'
              });
            }
          );
        }
      );
    }
  );
});

// GET /api/member/generate-pass
app.get('/api/member/generate-pass', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token is required.');

  db.get(
    'SELECT a.*, m.first_name, m.last_name FROM locker_assignments a JOIN members m ON a.member_id = m.id WHERE a.locker_token = ? AND a.status IN ("issued", "allocated")',
    [token],
    async (err, assignment) => {
      if (err || !assignment) {
        return res.status(403).send('Invalid or expired locker token pass request.');
      }

      const fs = require('fs');
      const { PKPass } = require('passkit-generator');

      const wwdrPath = process.env.APPLE_WWDR_CERT_PATH || 'certs/wwdr.pem';
      const passCertPath = process.env.APPLE_PASS_CERT_PATH || 'certs/pass.pem';
      const passKeyPath = process.env.APPLE_PASS_KEY_PATH || 'certs/pass.key';
      const passKeyPassword = process.env.APPLE_PASS_KEY_PASSWORD || '';

      const certsExist = fs.existsSync(wwdrPath) && fs.existsSync(passCertPath) && fs.existsSync(passKeyPath);

      if (!certsExist) {
        return res.json({
          configured: false,
          message: 'Apple Wallet certificates not configured. Rendered mock details:',
          mockPassData: {
            organizationName: 'Inzan Athletics',
            description: 'Gym Locker Pass',
            barcodeMessage: token,
            member: `${assignment.first_name} ${assignment.last_name}`
          }
        });
      }

      try {
        const wwdr = fs.readFileSync(wwdrPath);
        const signerCert = fs.readFileSync(passCertPath);
        const signerKey = fs.readFileSync(passKeyPath);

        const pass = new PKPass({
          model: {
            icon: path.join(__dirname, 'public/images/icon.png'),
            logo: path.join(__dirname, 'public/images/logo.png'),
          }
        }, { wwdr, signerCert, signerKey, signerKeyPassword });

        pass.setPassTypeIdentifier(process.env.APPLE_PASS_TYPE_IDENTIFIER);
        pass.setTeamIdentifier(process.env.APPLE_TEAM_IDENTIFIER);
        pass.setOrganizationName('Inzan Athletics');
        pass.setDescription(`Locker Pass for ${assignment.first_name} ${assignment.last_name}`);

        pass.fields.generic = {
          primaryFields: [
            { key: 'memberId', label: 'MEMBER ID', value: assignment.member_id }
          ],
          secondaryFields: [
            { key: 'status', label: 'STATUS', value: assignment.status.toUpperCase() }
          ],
          backFields: [
            { key: 'instructions', label: 'Instructions', value: 'Scan this pass at the locker room terminal to allocate and open your locker.' }
          ]
        };

        pass.setBarcodes({
          format: 'PKBarcodeFormatQR',
          message: token,
          messageEncoding: 'iso-8859-1',
          altText: `Locker Token: ${token}`
        });

        const buffer = await pass.asBuffer();
        res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
        res.setHeader('Content-Disposition', `attachment; filename=locker_pass.pkpass`);
        return res.send(buffer);
      } catch (error) {
        return res.status(500).send(`Failed to compile pass: ${error.message}`);
      }
    }
  );
});
```

Create the Member registration web page `public/member.html`:

```html
<!-- h:/inzanlockerbootstrap/public/member.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Get Locker Pass | Inzan Athletics</title>
    <link rel="stylesheet" href="css/style.css">
    <style>
        body { font-family: sans-serif; background: #1a1a1a; color: #fff; padding: 2rem; display: flex; justify-content: center; }
        .card { background: #2a2a2a; border-radius: 8px; padding: 2rem; width: 100%; max-width: 400px; box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
        .form-group { margin-bottom: 1.25rem; }
        label { display: block; margin-bottom: 0.5rem; font-weight: bold; }
        input { width: 93%; padding: 0.75rem; border-radius: 4px; border: 1px solid #444; background: #333; color: #fff; }
        button { width: 100%; padding: 0.75rem; border-radius: 4px; border: none; background: #00bcd4; color: #000; font-weight: bold; cursor: pointer; font-size: 1rem; }
        button:hover { background: #0097a7; }
        .error { color: #ff5252; margin-top: 1rem; display: none; }
        .success-box { margin-top: 1.5rem; text-align: center; display: none; }
        .pass-btn { display: inline-block; padding: 0.75rem 1.5rem; background: #000; color: #fff; text-decoration: none; border-radius: 4px; border: 1px solid #fff; font-weight: bold; margin-top: 1rem; }
    </style>
</head>
<body>
    <div class="card">
        <h2>Gym Locker Pass Registration</h2>
        <form id="passForm">
            <div class="form-group">
                <label for="memberId">Member ID</label>
                <input type="text" id="memberId" required placeholder="e.g. MEM-001">
            </div>
            <div class="form-group">
                <label for="lastName">Last Name</label>
                <input type="text" id="lastName" required placeholder="e.g. Smith">
            </div>
            <button type="submit">Generate Locker Pass</button>
        </form>
        <div id="errorMsg" class="error"></div>
        <div id="successBox" class="success-box">
            <p>Pass generated successfully!</p>
            <div id="passContainer"></div>
        </div>
    </div>
    <script>
        document.getElementById('passForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const memberId = document.getElementById('memberId').value;
            const lastName = document.getElementById('lastName').value;
            const errorMsg = document.getElementById('errorMsg');
            const successBox = document.getElementById('successBox');
            const passContainer = document.getElementById('passContainer');

            errorMsg.style.display = 'none';
            successBox.style.display = 'none';

            try {
                const response = await fetch('/api/member/issue-pass', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ memberId, lastName })
                });
                const data = await response.json();
                
                if (response.ok && data.success) {
                    successBox.style.display = 'block';
                    passContainer.innerHTML = `
                        <a href="/api/member/generate-pass?token=${data.locker_token}" class="pass-btn">
                            Get Apple Wallet Pass
                        </a>
                        <br><br>
                        <p>Or copy your Locker Token:<br><strong style="word-break: break-all;">${data.locker_token}</strong></p>
                    `;
                } else {
                    errorMsg.textContent = data.message || 'Verification failed.';
                    errorMsg.style.display = 'block';
                }
            } catch (err) {
                errorMsg.textContent = 'Server connection error.';
                errorMsg.style.display = 'block';
            }
        });
    </script>
</body>
</html>
```

**Step 4: Run test to verify it passes**

Start Express backend: `node server.js`
Run tests: `node --test test/pass_issuance.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add server.js public/member.html test/pass_issuance.test.js
git commit -m "feat: implement pass generation routes and member html UI"
```

---

## Task 3: Locker Room Terminal & Scanner Script

**Files:**
- Modify: `h:/inzanlockerbootstrap/server.js`
- Create: `h:/inzanlockerbootstrap/scripts/terminal_engine.py`
- Create: `h:/inzanlockerbootstrap/test/terminal.test.js`

**Step 1: Write the failing test**

Create `test/terminal.test.js`:

```javascript
// h:/inzanlockerbootstrap/test/terminal.test.js
const assert = require('assert');
const test = require('node:test');

test('Locker Room Terminal Endpoint', async (t) => {
  // Test invalid scanner token
  const resInvalid = await fetch('http://localhost:3000/api/terminal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: 'not-a-uuid' })
  });
  assert.strictEqual(resInvalid.status, 404);

  // Assert API accepts valid format token (returns 404 if not found in mock db)
  const resValidNotFound = await fetch('http://localhost:3000/api/terminal/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: '00000000-0000-0000-0000-000000000000' })
  });
  assert.strictEqual(resValidNotFound.status, 404);
});
```

**Step 2: Run test to verify it fails**

Ensure server is running: `node server.js`
Run: `node --test test/terminal.test.js`
Expected: FAIL with connection errors or 404 Route Not Found.

**Step 3: Write minimal implementation**

Refactor the existing MQTT publishing code in `server.js` into a globally accessible `triggerLockerUnlock` function, and write the `/api/terminal/scan` endpoint:

```javascript
// h:/inzanlockerbootstrap/server.js

// Extract triggerLockerUnlock helper function at root level:
function triggerLockerUnlock(lockerId, operator, ip, callback) {
  const lockerMeta = lockersConfig.find(l => l.name === lockerId);
  if (!lockerMeta) {
    return callback(new Error('Locker configuration not found'));
  }

  if (!mqttClient || !mqttClient.connected) {
    logAccess(lockerId, 'unlock', 'failed_no_broker', ip);
    return callback(new Error('MQTT broker not connected'));
  }

  let topic = config.MQTT_TOPIC_TEMPLATE.replace('{id}', lockerId);
  let payload = JSON.stringify({
    action: 'unlock',
    id: lockerId,
    operator: operator,
    timestamp: Date.now()
  });

  if (lockerMeta.command_topic) {
    topic = lockerMeta.command_topic;
    if (lockerMeta.protocol === 'aywana') {
      payload = 'ON';
    } else if (lockerMeta.protocol === 'rubik') {
      payload = JSON.stringify({ cmd: 'openlock', lock: lockerMeta.id });
    }
  }

  mqttClient.publish(topic, payload, { qos: 1 }, (error) => {
    if (error) {
      logAccess(lockerId, 'unlock', 'failed_broker_error', ip);
      return callback(error);
    }

    if (lockerMeta.protocol === 'aywana') {
      setTimeout(() => {
        console.log(`Auto-pulsing OFF for locker ${lockerId} on topic ${topic}...`);
        mqttClient.publish(topic, 'OFF', { qos: 1 }, (err) => {
          if (err) console.error('Failed to pulse OFF:', err);
        });
      }, 2000);
    }

    logAccess(lockerId, 'unlock', 'success', ip);
    callback(null);
  });
}

// Add the Terminal Scan endpoint:
// POST /api/terminal/scan
app.post('/api/terminal/scan', (req, res) => {
  const { locker_token } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!locker_token) {
    return res.status(400).json({ success: false, message: 'Locker token is required.' });
  }

  db.get(
    'SELECT a.*, m.gender FROM locker_assignments a JOIN members m ON a.member_id = m.id WHERE a.locker_token = ? LIMIT 1',
    [locker_token],
    (err, assignment) => {
      if (err || !assignment) {
        return res.status(404).json({ success: false, message: 'Invalid pass or locker token.' });
      }

      const twelveHours = 12 * 60 * 60 * 1000;
      if (Date.now() - assignment.issued_at > twelveHours) {
        db.run('UPDATE locker_assignments SET status = "expired" WHERE id = ?', [assignment.id]);
        return res.status(403).json({ success: false, message: 'Pass has expired (12-hour limit).' });
      }

      if (assignment.status === 'allocated') {
        const lockerId = assignment.locker_id;
        triggerLockerUnlock(lockerId, 'terminal_re-scan', ip, (unlockErr) => {
          if (unlockErr) {
            return res.status(500).json({ success: false, message: 'Locker is allocated but unlock command failed.', locker_id: lockerId });
          }
          return res.json({ success: true, action: 'unlock', locker_id: lockerId, first_scan: false });
        });
      } else if (assignment.status === 'issued') {
        const gender = assignment.gender; // 'male' or 'female'
        const genderQuery = gender === 'male'
          ? "SELECT * FROM lockers WHERE id LIKE 'M%' AND status = 'available' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) ASC LIMIT 1"
          : "SELECT * FROM lockers WHERE id LIKE 'F%' AND status = 'available' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) ASC LIMIT 1";

        db.get(genderQuery, [], (err, locker) => {
          if (err || !locker) {
            return res.status(404).json({ success: false, message: `No available ${gender} lockers.` });
          }

          const now = Date.now();
          db.serialize(() => {
            db.run('UPDATE lockers SET status = "occupied", access_token = ?, assigned_at = ? WHERE id = ?', [locker_token, now, locker.id]);
            db.run('UPDATE locker_assignments SET locker_id = ?, status = "allocated", assigned_at = ? WHERE id = ?', [locker.id, now, assignment.id], (assignErr) => {
              if (assignErr) {
                return res.status(500).json({ success: false, message: 'Error allocating locker.' });
              }

              triggerLockerUnlock(locker.id, 'terminal_first_scan', ip, (unlockErr) => {
                if (unlockErr) {
                  return res.status(500).json({ success: false, message: 'Locker allocated but unlock command failed.', locker_id: locker.id });
                }
                return res.json({ success: true, action: 'allocate', locker_id: locker.id, first_scan: true });
              });
            });
          });
        });
      } else {
        return res.status(403).json({ success: false, message: 'Pass status is invalid.' });
      }
    }
  );
});
```

Create the Python scanner CLI listener script `scripts/terminal_engine.py`:

```python
# h:/inzanlockerbootstrap/scripts/terminal_engine.py
import sys
import re
import urllib.request
import urllib.error
import json
import os

UUID_REGEX = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)
API_URL = os.environ.get("LOCKER_API_URL", "http://localhost:3000/api/terminal/scan")

def main():
    print("====================================================")
    print("Gym Locker Terminal Engine Active")
    print("Waiting for QR scans (emulating standard USB stdin)...")
    print("====================================================")
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
            
            scanned = line.strip()
            if not scanned:
                continue
                
            print(f"Scanned input: {scanned}")
            
            if not UUID_REGEX.match(scanned):
                print("\033[91mError: Scanned code is not a valid Locker Token (UUIDv4 format).\033[0m")
                continue
                
            # POST Request
            data = json.dumps({"locker_token": scanned}).encode('utf-8')
            req = urllib.request.Request(
                API_URL, 
                data=data, 
                headers={'Content-Type': 'application/json'}
            )
            
            try:
                with urllib.request.urlopen(req, timeout=5) as response:
                    res_body = response.read().decode('utf-8')
                    result = json.loads(res_body)
                    
                    if result.get("success"):
                        locker_id = result.get("locker_id")
                        action = result.get("action")
                        if action == "allocate":
                            print(f"\033[92mSUCCESS: Allocated Locker \033[1m{locker_id}\033[0m\033[92m (First Scan)!\033[0m")
                        else:
                            print(f"\033[92mSUCCESS: Unlocked Locker \033[1m{locker_id}\033[0m\033[92m!\033[0m")
                    else:
                        print(f"\033[91mFailed: {result.get('message')}\033[0m")
            except urllib.error.HTTPError as e:
                try:
                    err_msg = json.loads(e.read().decode('utf-8')).get('message', str(e))
                except Exception:
                    err_msg = str(e)
                print(f"\033[91mAPI Error: {err_msg}\033[0m")
            except urllib.error.URLError as e:
                print(f"\033[91mNetwork Error connecting to API: {e.reason}\033[0m")
                
        except KeyboardInterrupt:
            print("\nExiting Terminal Engine.")
            break
        except Exception as e:
            print(f"Unexpected error: {str(e)}")

if __name__ == "__main__":
    main()
```

**Step 4: Run test to verify it passes**

Start Express backend: `node server.js`
Run tests: `node --test test/terminal.test.js`
Expected: PASS

Verify python terminal execution with mock input:
`echo 64c39832-2d88-4f81-ba55-b4618e4726e6 | python scripts/terminal_engine.py`

**Step 5: Commit**

```bash
git add server.js scripts/terminal_engine.py test/terminal.test.js
git commit -m "feat: implement local terminal scanner script and backend API"
```

---

## Task 4: Presence & Auto-Vacate Engine

**Files:**
- Modify: `h:/inzanlockerbootstrap/server.js`
- Create: `h:/inzanlockerbootstrap/scripts/daily_cleanup.js`
- Create: `h:/inzanlockerbootstrap/test/auto_vacate.test.js`

**Step 1: Write the failing test**

Create `test/auto_vacate.test.js`:

```javascript
// h:/inzanlockerbootstrap/test/auto_vacate.test.js
const assert = require('assert');
const test = require('node:test');

test('Auto-Vacate turnstile webhook', async (t) => {
  // Try checkout with invalid auth header
  const resBadAuth = await fetch('http://localhost:3000/api/turnstile/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-turnstile-key': 'wrongkey'
    },
    body: JSON.stringify({ member_id: 'MEM-001' })
  });
  assert.strictEqual(resBadAuth.status, 401);

  // Try checkout with valid auth
  const resValid = await fetch('http://localhost:3000/api/turnstile/checkout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-turnstile-key': 'supersecretturnstilekey'
    },
    body: JSON.stringify({ member_id: 'MEM-001' })
  });
  assert.strictEqual(resValid.status, 200);
  const data = await resValid.json();
  assert.strictEqual(data.success, true);
});
```

**Step 2: Run test to verify it fails**

Ensure server is running: `node server.js`
Run: `node --test test/auto_vacate.test.js`
Expected: FAIL with connection errors or 404 Route Not Found.

**Step 3: Write minimal implementation**

Modify `server.js` to add the turnstile checkout webhook route:

```javascript
// h:/inzanlockerbootstrap/server.js

// POST /api/turnstile/checkout
app.post('/api/turnstile/checkout', (req, res) => {
  const turnstileKey = req.headers['x-turnstile-key'];
  const expectedKey = process.env.TURNSTILE_API_KEY || 'supersecretturnstilekey';

  if (!turnstileKey || turnstileKey !== expectedKey) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Turnstile key is invalid.' });
  }

  const { member_id } = req.body;
  if (!member_id) {
    return res.status(400).json({ success: false, message: 'member_id is required.' });
  }

  db.get(
    'SELECT * FROM locker_assignments WHERE member_id = ? AND status = "allocated" LIMIT 1',
    [member_id],
    (err, assignment) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error fetching active assignments.' });
      }

      if (!assignment) {
        return res.json({ success: true, message: 'No active locker assignment found to vacate.' });
      }

      const lockerId = assignment.locker_id;
      db.serialize(() => {
        db.run('UPDATE lockers SET status = "available", access_token = NULL, assigned_at = NULL WHERE id = ?', [lockerId]);
        db.run('UPDATE locker_assignments SET status = "vacated", vacated_at = ? WHERE id = ?', [Date.now(), assignment.id]);
        logAccess(lockerId, 'auto_vacate_turnstile', 'success', req.ip || 'turnstile_webhook');
      });

      return res.json({ success: true, message: `Locker ${lockerId} successfully vacated on check-out.` });
    }
  );
});
```

Create daily 2 AM cleanup script `scripts/daily_cleanup.js`:

```javascript
// h:/inzanlockerbootstrap/scripts/daily_cleanup.js
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
```

Configure Windows task scheduler (PowerShell):
`schtasks /create /tn "GymLockerAutoVacateCleanup" /tr "node H:\inzanlockerbootstrap\scripts\daily_cleanup.js" /sc daily /st 02:00`

Or Linux Cron entry:
`0 2 * * * cd /path/to/app && node scripts/daily_cleanup.js >> logs/cron_cleanup.log 2>&1`

**Step 4: Run test to verify it passes**

Start Express backend: `node server.js`
Run tests: `node --test test/auto_vacate.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add server.js scripts/daily_cleanup.js test/auto_vacate.test.js
git commit -m "feat: add turnstile webhook and daily cron cleanup script"
```

---

## Task 5: Backup Web-Unlock Portal

**Files:**
- Modify: `h:/inzanlockerbootstrap/server.js`
- Create: `h:/inzanlockerbootstrap/public/portal.html`
- Create: `h:/inzanlockerbootstrap/test/portal.test.js`

**Step 1: Write the failing test**

Create `test/portal.test.js`:

```javascript
// h:/inzanlockerbootstrap/test/portal.test.js
const assert = require('assert');
const test = require('node:test');

test('Backup Portal authentication and unlock API', async (t) => {
  // Test authentication endpoint
  const resLogin = await fetch('http://localhost:3000/api/member/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId: 'MEM-001', lastName: 'Smith' })
  });
  assert.strictEqual(resLogin.status, 200 || 404); // returns 404 if no assignments exist yet

  // Test geofenced unlock with coordinates far away (fails proximity check)
  const resUnlockBlocked = await fetch('http://localhost:3000/api/member/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locker_token: '00000000-0000-0000-0000-000000000000', lat: 45.0, lon: -90.0 })
  });
  assert.strictEqual(resUnlockBlocked.status, 432 || 403);
});
```

**Step 2: Run test to verify it fails**

Ensure server is running: `node server.js`
Run: `node --test test/portal.test.js`
Expected: FAIL with connection errors or 404 Route Not Found.

**Step 3: Write minimal implementation**

Modify `server.js` to add login and geofenced member unlock endpoints:

```javascript
// h:/inzanlockerbootstrap/server.js

// POST /api/member/login
app.post('/api/member/login', (req, res) => {
  const { memberId, lastName } = req.body;
  if (!memberId || !lastName) {
    return res.status(400).json({ success: false, message: 'Member ID and Last Name are required.' });
  }

  db.get(
    'SELECT * FROM members WHERE id = ? AND LOWER(last_name) = ? AND status = "active"',
    [memberId.trim(), lastName.trim().toLowerCase()],
    (err, member) => {
      if (err || !member) {
        return res.status(401).json({ success: false, message: 'Invalid active Member credentials.' });
      }

      db.get(
        'SELECT * FROM locker_assignments WHERE member_id = ? AND status = "allocated" LIMIT 1',
        [member.id],
        (err, assignment) => {
          if (err) {
            return res.status(500).json({ success: false, message: 'Database error.' });
          }

          if (!assignment) {
            return res.status(404).json({ success: false, message: 'No active locker assignments found. Scan pass at terminal first.' });
          }

          return res.json({
            success: true,
            locker_id: assignment.locker_id,
            locker_token: assignment.locker_token
          });
        }
      );
    }
  );
});

// POST /api/member/unlock
app.post('/api/member/unlock', (req, res) => {
  const { locker_token, lat, lon } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!locker_token) {
    return res.status(400).json({ success: false, message: 'Locker token is required.' });
  }

  if (lat === undefined || lon === undefined) {
    return res.status(400).json({ success: false, message: 'GPS coordinates are required to unlock your locker.' });
  }

  const distance = getDistance(parseFloat(lat), parseFloat(lon), GYM_LAT, GYM_LON);
  if (distance > MAX_DISTANCE_METERS) {
    return res.status(403).json({
      success: false,
      message: `Access Denied: You must be inside the gym. (Distance: ${Math.round(distance)}m)`
    });
  }

  db.get(
    'SELECT * FROM locker_assignments WHERE locker_token = ? AND status = "allocated" LIMIT 1',
    [locker_token],
    (err, assignment) => {
      if (err || !assignment) {
        return res.status(404).json({ success: false, message: 'Active assignment not found.' });
      }

      const twelveHours = 12 * 60 * 60 * 1000;
      if (Date.now() - assignment.assigned_at > twelveHours) {
        return res.status(403).json({ success: false, message: 'Assignment has expired.' });
      }

      triggerLockerUnlock(assignment.locker_id, 'member_web_portal', ip, (unlockErr) => {
        if (unlockErr) {
          return res.status(500).json({ success: false, message: 'Failed to unlock locker. Connection error.' });
        }
        return res.json({ success: true, message: `Locker ${assignment.locker_id} unlocked successfully.` });
      });
    }
  );
});
```

Create backup web-unlock user portal HTML `public/portal.html`:

```html
<!-- h:/inzanlockerbootstrap/public/portal.html -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Member Locker Control | Inzan Athletics</title>
    <style>
        body { font-family: sans-serif; background: #121212; color: #fff; text-align: center; padding: 2rem; }
        .box { background: #1e1e1e; padding: 2rem; max-width: 400px; margin: 0 auto; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }
        .btn { display: block; width: 100%; padding: 1rem; margin-top: 1.5rem; background: #00e676; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 1.1rem; text-transform: uppercase; color: #000; }
        .btn:hover { background: #00c853; }
        input { width: 90%; padding: 0.75rem; margin-bottom: 1rem; border-radius: 4px; border: 1px solid #333; background: #2b2b2b; color: #fff; }
        .hidden { display: none; }
        .error { color: #ff5252; margin-top: 1rem; }
        .success { color: #00e676; margin-top: 1rem; font-weight: bold; }
    </style>
</head>
<body>
    <div class="box">
        <h2>Gym Locker Backup Portal</h2>
        
        <div id="loginView">
            <input type="text" id="memberId" placeholder="Member ID">
            <input type="text" id="lastName" placeholder="Last Name">
            <button class="btn" onclick="login()">Login</button>
            <div id="loginErr" class="error"></div>
        </div>

        <div id="controlView" class="hidden">
            <h3>Welcome, Member!</h3>
            <p>Your Assigned Locker: <strong id="lockerDisplay" style="font-size: 1.5rem; color: #00bcd4;">-</strong></p>
            <button class="btn" onclick="requestUnlock()">Open Locker Relay</button>
            <div id="statusMsg"></div>
        </div>
    </div>

    <script>
        let lockerToken = '';
        
        async function login() {
            const memberId = document.getElementById('memberId').value;
            const lastName = document.getElementById('lastName').value;
            const errorDiv = document.getElementById('loginErr');
            errorDiv.textContent = '';

            try {
                const res = await fetch('/api/member/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ memberId, lastName })
                });
                const data = await res.json();
                
                if (res.ok && data.success) {
                    lockerToken = data.locker_token;
                    document.getElementById('lockerDisplay').textContent = data.locker_id;
                    document.getElementById('loginView').classList.add('hidden');
                    document.getElementById('controlView').classList.remove('hidden');
                } else {
                    errorDiv.textContent = data.message || 'Verification error.';
                }
            } catch(e) {
                errorDiv.textContent = 'Server communication error.';
            }
        }

        function requestUnlock() {
            const msgDiv = document.getElementById('statusMsg');
            msgDiv.className = '';
            msgDiv.textContent = 'Verifying geofence and requesting unlock...';

            navigator.geolocation.getCurrentPosition(async (pos) => {
                const lat = pos.coords.latitude;
                const lon = pos.coords.longitude;

                try {
                    const res = await fetch('/api/member/unlock', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ locker_token: lockerToken, lat, lon })
                    });
                    const data = await res.json();
                    
                    if (res.ok && data.success) {
                        msgDiv.className = 'success';
                        msgDiv.textContent = data.message;
                    } else {
                        msgDiv.className = 'error';
                        msgDiv.textContent = data.message || 'Unlock request failed.';
                    }
                } catch(e) {
                    msgDiv.className = 'error';
                    msgDiv.textContent = 'Connection error transmitting request.';
                }
            }, (err) => {
                msgDiv.className = 'error';
                msgDiv.textContent = 'Geolocation request denied. Proximity check cannot be validated.';
            });
        }
    </script>
</body>
</html>
```

**Step 4: Run test to verify it passes**

Start Express backend: `node server.js`
Run tests: `node --test test/portal.test.js`
Expected: PASS

**Step 5: Commit**

```bash
git add server.js public/portal.html test/portal.test.js
git commit -m "feat: complete member backup unlock portal with geofencing check"
```
