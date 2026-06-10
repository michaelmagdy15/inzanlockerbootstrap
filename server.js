const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, dbReady } = require('./database');
require('dotenv').config();

const lockersConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'lockers_config.json'), 'utf8'));

const app = express();

// Enable trust proxy for Cloud Run HTTPS resolution
app.enable('trust proxy');

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static('public'));

// In-memory store for 60-second front desk override bypass tokens
const overrideTokens = new Map();

// Dynamic System Configuration Object
const config = {
  PORT: process.env.PORT || 3000,
  RECEPTION_PIN: process.env.RECEPTION_PIN || '1234',
  MQTT_BROKER: process.env.MQTT_BROKER || 'mqtt://192.168.68.2',
  MQTT_PORT: parseInt(process.env.MQTT_PORT || '1883', 10),
  MQTT_USER: process.env.MQTT_USER || 'mqtt',
  MQTT_PASSWORD: process.env.MQTT_PASSWORD || '',
  MQTT_TOPIC_TEMPLATE: process.env.MQTT_TOPIC_TEMPLATE || 'gym/lockers/{id}/command',
  BASE_URL: process.env.BASE_URL || ''
};

// Load configuration from database
function loadSettingsFromDb() {
  return new Promise((resolve) => {
    db.all('SELECT key, value FROM settings', [], (err, rows) => {
      if (!err && rows) {
        rows.forEach((row) => {
          if (row.key === 'MQTT_PORT') {
            config.MQTT_PORT = parseInt(row.value, 10);
          } else {
            config[row.key] = row.value;
          }
        });
      }
      resolve();
    });
  });
}

// MQTT Client Management
let mqttClient = null;

function connectMQTT() {
  if (process.env.NODE_ENV === 'test') {
    console.log('Running in TEST mode. Mocking MQTT connection.');
    mqttClient = {
      connected: true,
      publish: (topic, payload, options, callback) => {
        console.log(`[MOCK MQTT PUBLISH] Topic: ${topic}, Payload: ${payload}`);
        if (typeof callback === 'function') {
          callback(null);
        } else if (typeof options === 'function') {
          options(null);
        }
      },
      on: () => {},
      end: () => {}
    };
    return;
  }

  if (mqttClient) {
    console.log('Disconnecting existing MQTT Client...');
    mqttClient.end();
    mqttClient = null;
  }

  const mqttOptions = {
    port: config.MQTT_PORT,
    username: config.MQTT_USER,
    password: config.MQTT_PASSWORD,
    reconnectPeriod: 5000,
    connectTimeout: 30 * 1000,
  };

  console.log(`Connecting to MQTT Broker at ${config.MQTT_BROKER}:${config.MQTT_PORT}...`);
  mqttClient = mqtt.connect(config.MQTT_BROKER, mqttOptions);

  mqttClient.on('connect', () => {
    console.log('Successfully connected to MQTT Broker.');
  });
  mqttClient.on('error', (err) => {
    console.error('MQTT Client Error:', err.message);
  });
}

// Middleware: Check Reception PIN authorization for admin/console actions
function authorizeReception(req, res, next) {
  const pinHeader = req.headers['x-reception-pin'];
  if (!pinHeader || pinHeader !== config.RECEPTION_PIN) {
    return res.status(401).json({ success: false, message: 'Unauthorized. PIN missing or incorrect.' });
  }
  next();
}

// Helper: Log access and rate-limit check
function logAccess(lockerId, action, status, ip, isFlagged = 0, flagReason = null) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO access_logs (locker_id, action, status, ip_address, timestamp, is_flagged, flag_reason) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [lockerId, action, status, ip, Date.now(), isFlagged, flagReason],
      function (err) {
        if (err) {
          console.error('Failed to write access log to SQLite:', err.message);
          reject(err);
        } else {
          resolve(this.lastID);
        }
      }
    );
  });
}

// Helper: Trigger physical relay unlock command via MQTT
function triggerLockerUnlock(lockerId, operator, ip, isFlagged = 0, flagReason = null, callback) {
  const lockerMeta = lockersConfig.find(l => l.name === lockerId);
  if (!lockerMeta) {
    return callback(new Error('Locker configuration not found'));
  }

  if (!mqttClient || !mqttClient.connected) {
    logAccess(lockerId, 'unlock', 'failed_no_broker', ip, isFlagged, flagReason);
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

  mqttClient.publish(topic, payload, { qos: 1 }, async (error) => {
    if (error) {
      console.error(`Failed to publish unlock command for locker #${lockerId}:`, error);
      await logAccess(lockerId, 'unlock', 'failed_broker_error', ip, isFlagged, flagReason);
      return callback(error);
    }

    if (lockerMeta.protocol === 'aywana') {
      setTimeout(() => {
        console.log(`Auto-pulsing OFF for locker ${lockerId} on topic ${topic}...`);
        mqttClient.publish(topic, 'OFF', { qos: 1 }, (err) => {
          if (err) console.error('Failed to auto-pulse OFF:', err);
        });
      }, 2000);
    }

    await logAccess(lockerId, 'unlock', 'success', ip, isFlagged, flagReason);
    callback(null);
  });
}

// ----------------- RECEPTION DASHBOARD API -----------------

// GET /api/reception/lockers
app.get('/api/reception/lockers', authorizeReception, (req, res) => {
  db.all("SELECT * FROM lockers ORDER BY SUBSTR(id, 1, 1) DESC, CAST(SUBSTR(id, 2) AS INTEGER) ASC", [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error reading lockers.' });
    }
    return res.json({ success: true, lockers: rows });
  });
});

// POST /api/reception/assign (Generate Token and occupy locker)
app.post('/api/reception/assign', authorizeReception, (req, res) => {
  const { lockerId } = req.body;
  const cleanLockerId = lockerId ? lockerId.toString().trim() : '';

  if (!cleanLockerId) {
    return res.status(400).json({ success: false, message: 'Invalid or missing Locker ID.' });
  }
  
  // Generate a secure 16-character token
  const accessToken = crypto.randomBytes(8).toString('hex');

  db.run(
    "UPDATE lockers SET status = 'occupied', access_token = ?, assigned_at = ? WHERE id = ? AND status = 'available'",
    [accessToken, Date.now(), cleanLockerId],
    function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error allocating locker.' });
      }

      if (this.changes === 0) {
        return res.status(400).json({ success: false, message: 'Locker is already assigned or does not exist.' });
      }

      return res.status(200).json({
        success: true,
        message: `Locker #${cleanLockerId} successfully assigned.`,
        accessToken
      });
    }
  );
});

// POST /api/reception/release (Clear token and free locker)
app.post('/api/reception/release', authorizeReception, (req, res) => {
  const { lockerId } = req.body;
  const cleanLockerId = lockerId ? lockerId.toString().trim() : '';

  if (!cleanLockerId) {
    return res.status(400).json({ success: false, message: 'Invalid or missing Locker ID.' });
  }

  db.run(
    "UPDATE lockers SET status = 'available', access_token = NULL, assigned_at = NULL WHERE id = ?",
    [cleanLockerId],
    function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error freeing locker.' });
      }
      return res.status(200).json({ success: true, message: `Locker #${cleanLockerId} released and is now available.` });
    }
  );
});

// POST /api/reception/unlock (Admin override direct unlock)
app.post('/api/reception/unlock', authorizeReception, (req, res) => {
  const { lockerId } = req.body;
  const cleanLockerId = lockerId ? lockerId.toString().trim() : '';
  const ip = req.ip || req.connection.remoteAddress;

  if (!cleanLockerId) {
    return res.status(400).json({ success: false, message: 'Invalid or missing Locker ID.' });
  }

  triggerLockerUnlock(cleanLockerId, 'admin_console', ip, 0, null, (error) => {
    if (error) {
      return res.status(500).json({ success: false, message: `Failed to transmit unlock command: ${error.message}` });
    }
    return res.status(200).json({
      success: true,
      message: `Locker #${cleanLockerId} successfully unlocked by administrator.`
    });
  });
});

// POST /api/reception/maintenance (Toggle locker maintenance mode)
app.post('/api/reception/maintenance', authorizeReception, (req, res) => {
  const { lockerId, maintenance } = req.body;
  const cleanLockerId = lockerId ? lockerId.toString().trim() : '';
  const ip = req.ip || req.connection.remoteAddress;

  if (!cleanLockerId || maintenance === undefined) {
    return res.status(400).json({ success: false, message: 'Locker ID and maintenance state (true/false) are required.' });
  }

  const newStatus = maintenance ? 'maintenance' : 'available';

  db.run(
    "UPDATE lockers SET status = ? WHERE id = ? AND status IN ('available', 'maintenance')",
    [newStatus, cleanLockerId],
    async function (err) {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error updating locker status.' });
      }

      if (this.changes === 0) {
        return res.status(400).json({ 
          success: false, 
          message: 'Locker is currently occupied or not found. Please release it before changing maintenance status.' 
        });
      }

      await logAccess(cleanLockerId, maintenance ? 'maint_enable' : 'maint_disable', 'success', ip);
      return res.status(200).json({ 
        success: true, 
        message: `Locker #${cleanLockerId} is now ${newStatus === 'maintenance' ? 'under maintenance' : 'active and available'}.` 
      });
    }
  );
});

// POST /api/auto-assign (Self-service locker allocation by gender)
app.post('/api/auto-assign', (req, res) => {
  const { gender } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!gender || (gender !== 'male' && gender !== 'female')) {
    return res.status(400).json({ success: false, message: 'Gender selection is required.' });
  }

  // Query available lockers using SQLite pattern matching:
  // Male lockers start with 'M', Female lockers start with 'F'.
  // We order them by their numeric suffix.
  const query = gender === 'male' 
    ? "SELECT * FROM lockers WHERE id LIKE 'M%' AND status = 'available' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) ASC LIMIT 1"
    : "SELECT * FROM lockers WHERE id LIKE 'F%' AND status = 'available' ORDER BY CAST(SUBSTR(id, 2) AS INTEGER) ASC LIMIT 1";

  db.get(
    query,
    [],
    (err, locker) => {
      if (err) {
        console.error('Database query error during auto-assign:', err.message);
        return res.status(500).json({ success: false, message: 'Database error finding an available locker.' });
      }

      if (!locker) {
        return res.status(404).json({
          success: false,
          message: `All ${gender === 'male' ? 'Male' : 'Female'} lockers are currently occupied. Please see the reception desk.`
        });
      }

      // Generate secure 16-character access token
      const accessToken = crypto.randomBytes(8).toString('hex');
      const assignedAt = Date.now();

      // Allocate the locker in the database
      db.run(
        "UPDATE lockers SET status = 'occupied', access_token = ?, assigned_at = ? WHERE id = ? AND status = 'available'",
        [accessToken, assignedAt, locker.id],
        async function (updateErr) {
          if (updateErr) {
            console.error('Database update error during auto-assign:', updateErr.message);
            return res.status(500).json({ success: false, message: 'Database error allocating locker.' });
          }

          // Handle potential concurrency update race condition
          if (this.changes === 0) {
            return res.status(409).json({ success: false, message: 'Locker allocation conflict. Please try again.' });
          }

          // Log the successful auto-assignment
          await logAccess(locker.id, 'auto_assign', 'success', ip);

          return res.status(200).json({
            success: true,
            message: `Locker #${locker.id} assigned successfully.`,
            lockerId: locker.id,
            accessToken
          });
        }
      );
    }
  );
});

// POST /api/client-release (Allows client to release their own locker)
app.post('/api/client-release', (req, res) => {
  const { lockerId, token } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const targetLockerId = lockerId ? lockerId.toString().trim() : '';

  if (!targetLockerId || !token) {
    return res.status(400).json({ success: false, message: 'Locker ID and token are required.' });
  }

  db.get('SELECT * FROM lockers WHERE id = ?', [targetLockerId], async (err, locker) => {
    if (err || !locker) {
      return res.status(404).json({ success: false, message: 'Locker not found.' });
    }

    if (locker.status !== 'occupied' || locker.access_token !== token) {
      return res.status(403).json({ success: false, message: 'Invalid or expired token.' });
    }

    db.run(
      "UPDATE lockers SET status = 'available', access_token = NULL, assigned_at = NULL WHERE id = ?",
      [targetLockerId],
      async function (updateErr) {
        if (updateErr) {
          return res.status(500).json({ success: false, message: 'Database error releasing locker.' });
        }

        await logAccess(targetLockerId, 'client_release', 'success', ip);
        return res.status(200).json({ success: true, message: `Locker #${targetLockerId} successfully released.` });
      }
    );
  });
});

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
        return res.status(401).json({ success: false, message: 'Invalid active Member credentials.' });
      }

      // Look up existing active pass
      db.get(
        'SELECT * FROM locker_assignments WHERE member_id = ? AND status IN ("issued", "allocated") LIMIT 1',
        [member.id],
        (err, existing) => {
          if (!err && existing) {
            // If the pass has been allocated, it should NEVER expire based on time-elapsed checks.
            if (existing.status === 'allocated') {
              return sendPassResponse(member, existing.locker_token, existing.status, res);
            }

            const twelveHours = 12 * 60 * 60 * 1000;
            if (Date.now() - existing.issued_at < twelveHours) {
              return sendPassResponse(member, existing.locker_token, existing.status, res);
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
              return sendPassResponse(member, token, 'issued', res);
            }
          );
        }
      );
    }
  );
});

// Helper function to issue or mock PassKit pass
async function sendPassResponse(member, lockerToken, status, res) {
  const apiKey = process.env.PASSKIT_API_KEY;
  const apiSecret = process.env.PASSKIT_API_SECRET;
  const templateId = process.env.PASSKIT_TEMPLATE_ID;

  const baseUrl = config.BASE_URL || `${res.req.protocol}://${res.req.get('host')}`;

  if (apiKey && apiSecret && templateId) {
    try {
      const authHeader = 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64');
      console.log(`Requesting PassKit API for member ${member.id}...`);

      const passkitRes = await fetch('https://api.pub1.passkit.io/v3/passes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify({
          templateId: templateId,
          externalId: member.id,
          userData: {
            displayName: `${member.first_name} ${member.last_name}`,
            memberId: member.id
          },
          barcode: {
            message: lockerToken,
            format: 'PKBarcodeFormatQR'
          }
        })
      });

      const data = await passkitRes.json();
      if (passkitRes.ok && data.url) {
        return res.json({
          success: true,
          walletUrl: data.url,
          locker_token: lockerToken,
          status: status,
          message: 'Pass generated successfully via PassKit'
        });
      } else {
        console.error('PassKit API rejected request:', data);
        const mockUrl = `${baseUrl}/api/member/mock-passkit-landing?token=${lockerToken}`;
        return res.json({
          success: true,
          walletUrl: mockUrl,
          locker_token: lockerToken,
          status: status,
          message: 'Pass generated with mock fallback due to PassKit error'
        });
      }
    } catch (err) {
      console.error('PassKit API network request failure:', err.message);
      const mockUrl = `${baseUrl}/api/member/mock-passkit-landing?token=${lockerToken}`;
      return res.json({
        success: true,
        walletUrl: mockUrl,
        locker_token: lockerToken,
        status: status,
        message: 'Pass generated with mock fallback due to network failure'
      });
    }
  } else {
    // Return mock landing page URL when PassKit environment variables are not configured
    const mockUrl = `${baseUrl}/api/member/mock-passkit-landing?token=${lockerToken}`;
    return res.json({
      success: true,
      walletUrl: mockUrl,
      locker_token: lockerToken,
      status: status,
      message: 'Pass generated with mock fallback (PassKit env variables missing)'
    });
  }
}

// GET /api/member/mock-passkit-landing (Mock landing page for PassKit)
app.get('/api/member/mock-passkit-landing', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Token is required.');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>PassKit Mock Pass Center</title>
      <link rel="stylesheet" href="/style.css">
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap" rel="stylesheet">
    </head>
    <body style="display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #000; color: #fff; font-family: 'Outfit', sans-serif;">
      <div class="glass-card" style="padding: 30px; text-align: center; max-width: 400px; width: 100%;">
        <div style="font-size: 40px; margin-bottom: 15px;">🎫</div>
        <h2 style="font-weight: 800; margin-bottom: 10px;">PassKit Mock Landing</h2>
        <p style="color: var(--text-secondary); font-size: 14px; margin-bottom: 24px; line-height: 1.5;">
          This is a simulated PassKit download page. Click below to add the locker pass directly to your device wallet.
        </p>
        <a href="/api/member/generate-pass?token=${token}" class="submit-btn" style="display: inline-flex; justify-content: center; align-items: center; width: 100%; text-decoration: none; color: #000; background: #fff; font-weight: 700; height: 44px; border-radius: 8px;">
          Add to Apple Wallet
        </a>
      </div>
    </body>
    </html>
  `);
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
          message: 'Apple Wallet certificates not configured.',
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

// POST /api/terminal/scan
app.post('/api/terminal/scan', (req, res) => {
  const { locker_token } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!locker_token) {
    return res.status(400).json({ success: false, message: 'Locker token is required.' });
  }

  const uuidGeneralRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidGeneralRegex.test(locker_token)) {
    return res.status(404).json({ success: false, message: 'Invalid token format.' });
  }

  db.get(
    'SELECT a.*, m.gender FROM locker_assignments a JOIN members m ON a.member_id = m.id WHERE a.locker_token = ? LIMIT 1',
    [locker_token],
    (err, assignment) => {
      if (err || !assignment) {
        return res.status(404).json({ success: false, message: 'Invalid pass or locker token.' });
      }

      if (assignment.status === 'issued') {
        const twelveHours = 12 * 60 * 60 * 1000;
        if (Date.now() - assignment.issued_at > twelveHours) {
          db.run('UPDATE locker_assignments SET status = "expired" WHERE id = ?', [assignment.id]);
          return res.status(403).json({ success: false, message: 'Pass has expired (12-hour limit).' });
        }
      }

      if (assignment.status === 'allocated') {
        const lockerId = assignment.locker_id;
        triggerLockerUnlock(lockerId, 'terminal_re-scan', ip, 0, null, (unlockErr) => {
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

              triggerLockerUnlock(locker.id, 'terminal_first_scan', ip, 0, null, (unlockErr) => {
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

// ----------------- CLIENT UNLOCK API -----------------

// Gym Location Coordinates (Inzan Athletics)
const GYM_LAT = 30.046123;
const GYM_LON = 31.483873;
const MAX_DISTANCE_METERS = 50; // Allow 50m radius due to indoor GPS deviations

// Haversine formula to calculate distance in meters between two coordinates
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c; // in meters
}

// POST /api/unlock-locker
app.post('/api/unlock-locker', (req, res) => {
  const { lockerId, token, lat, lon } = req.body;
  const ip = req.ip || req.connection.remoteAddress;
  const targetLockerId = lockerId ? lockerId.toString().trim() : '';

  if (!targetLockerId || !token) {
    return res.status(400).json({
      success: false,
      message: 'Locker ID and access token are required.'
    });
  }

  // Validate geofence coordinates
  if (lat === undefined || lon === undefined) {
    return res.status(400).json({
      success: false,
      message: 'Location coordinates are required to unlock your locker. Please enable location services on your device.'
    });
  }

  const distance = getDistance(parseFloat(lat), parseFloat(lon), GYM_LAT, GYM_LON);
  if (distance > MAX_DISTANCE_METERS) {
    console.warn(`[GEOFENCE BLOCKED] Locker #${targetLockerId} unlock attempt blocked from IP ${ip}. Distance: ${Math.round(distance)}m`);
    // Log the geofence failure event in the database access logs
    logAccess(targetLockerId, 'unlock', 'failed_geofence', ip, 1, `Blocked by geofence (Distance: ${Math.round(distance)}m)`);
    return res.status(403).json({
      success: false,
      message: `Access Denied: You must be physically inside the gym to unlock your locker. (Distance: ${Math.round(distance)}m)`
    });
  }

  // Validate the access token matches the occupied locker
  db.get('SELECT * FROM lockers WHERE id = ?', [targetLockerId], async (err, locker) => {
    if (err || !locker) {
      await logAccess(targetLockerId, 'unlock', 'not_found', ip, 1, 'Locker not found in database');
      return res.status(404).json({ success: false, message: 'Locker not found.' });
    }

    if (locker.status !== 'occupied' || locker.access_token !== token) {
      // Security warning: unauthorized access attempt logged & flagged as anomaly
      await logAccess(targetLockerId, 'unlock', 'forbidden', ip, 1, 'Unauthorized or expired token attempt');
      return res.status(403).json({
        success: false,
        message: 'Invalid or expired access token. Please scan the QR code at reception to refresh.'
      });
    }

    // Anomaly Detection: Rate limit access attempts (e.g. >3 requests within 60 seconds for this locker)
    const sixtySecondsAgo = Date.now() - 60000;
    db.get(
      `SELECT COUNT(*) as recentAttempts FROM access_logs 
       WHERE locker_id = ? AND timestamp > ?`,
      [targetLockerId, sixtySecondsAgo],
      async (err, row) => {
        if (err) {
          console.error('Failed to audit recent attempts count:', err.message);
        }

        const recentAttempts = row ? row.recentAttempts : 0;
        let isFlagged = 0;
        let flagReason = null;

        if (recentAttempts >= 3) {
          isFlagged = 1;
          flagReason = 'Excessive rapid unlock attempts (Rate anomaly flagged)';
          console.warn(`[ANOMALY ALERT] Locker #${targetLockerId} flagged for excessive unlock attempts.`);
        }

        triggerLockerUnlock(targetLockerId, 'token_client', ip, isFlagged, flagReason, (error) => {
          if (error) {
            return res.status(500).json({ success: false, message: `Failed to transmit unlock command: ${error.message}` });
          }

          let warningMessage = undefined;
          if (isFlagged) {
            warningMessage = 'Locker unlocked, but excessive attempts were flagged for security review.';
          }

          return res.status(200).json({
            success: true,
            message: warningMessage || `Locker #${targetLockerId} unlocked successfully.`
          });
        });
      }
    );
  });
});

// GET /api/verify-token (Verify if a token is still active and valid)
app.get('/api/verify-token', (req, res) => {
  const { locker, token } = req.query;
  const targetLockerId = locker ? locker.toString().trim() : '';

  if (!targetLockerId || !token) {
    return res.status(400).json({ success: false, message: 'Locker ID and token are required.' });
  }

  db.get('SELECT * FROM lockers WHERE id = ?', [targetLockerId], (err, lockerRow) => {
    if (err || !lockerRow) {
      return res.json({ success: true, valid: false, message: 'Locker not found.' });
    }

    if (lockerRow.status !== 'occupied' || lockerRow.access_token !== token) {
      return res.json({ success: true, valid: false, message: 'Token is invalid or locker is released.' });
    }

    return res.json({ success: true, valid: true, message: 'Token is valid.' });
  });
});

// GET /api/generate-pass (Compiles the pass, embeds the locker and token query params)
app.get('/api/generate-pass', async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const { PKPass } = require('passkit-generator');

  const { locker, token } = req.query;
  const targetLockerId = locker ? locker.toString().trim() : '';

  if (!targetLockerId || !token) {
    return res.status(400).send('Locker ID and token are required.');
  }

  // Validate database status first
  db.get('SELECT * FROM lockers WHERE id = ?', [targetLockerId], async (err, lockerRow) => {
    if (err || !lockerRow || lockerRow.status !== 'occupied' || lockerRow.access_token !== token) {
      return res.status(403).send('Forbidden. Access token is invalid or expired.');
    }

    const baseUrl = config.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const unlockUrl = `${baseUrl}/?locker=${targetLockerId}&token=${token}`;

    const wwdrPath = process.env.APPLE_WWDR_CERT_PATH || 'certs/wwdr.pem';
    const passCertPath = process.env.APPLE_PASS_CERT_PATH || 'certs/pass.pem';
    const passKeyPath = process.env.APPLE_PASS_KEY_PATH || 'certs/pass.key';
    const passKeyPassword = process.env.APPLE_PASS_KEY_PASSWORD || '';

    const certsExist = fs.existsSync(wwdrPath) && fs.existsSync(passCertPath) && fs.existsSync(passKeyPath);

    if (!certsExist) {
      // Fallback response with setup instructions and mock pass details
      return res.json({
        configured: false,
        message: 'Apple Wallet signing certificates are not configured.',
        mockPassData: {
          passType: 'generic',
          organizationName: 'Inzan Athletics',
          description: `Access Pass for Gym Locker #${targetLockerId}`,
          logoText: 'INZAN ATHLETICS',
          barcode: {
            format: 'PKBarcodeFormatQR',
            message: unlockUrl,
            messageEncoding: 'iso-8859-1',
            altText: `Locker #${targetLockerId}`
          },
          primaryFields: [
            { key: 'lockerId', label: 'LOCKER NUMBER', value: `#${targetLockerId}` }
          ]
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
      }, {
        wwdr,
        signerCert,
        signerKey,
        signerKeyPassword: passKeyPassword
      });

      pass.setPassTypeIdentifier(process.env.APPLE_PASS_TYPE_IDENTIFIER);
      pass.setTeamIdentifier(process.env.APPLE_TEAM_IDENTIFIER);
      pass.setOrganizationName('Inzan Athletics');
      pass.setDescription(`Locker Access Pass - #${targetLockerId}`);

      pass.fields.generic = {
        primaryFields: [
          { key: 'lockerId', label: 'LOCKER NO', value: `#${targetLockerId}` }
        ],
        secondaryFields: [
          { key: 'status', label: 'STATUS', value: 'ACTIVE' }
        ],
        backFields: [
          { key: 'info', label: 'Locker Instructions', value: 'This ticket lets you unlock Locker #' + targetLockerId + ' at Inzan Athletics. Scan the QR code or tap the link to trigger the lock.' },
          { key: 'link', label: 'Unlock Link', value: unlockUrl }
        ]
      };

      pass.setBarcodes({
        format: 'PKBarcodeFormatQR',
        message: unlockUrl,
        messageEncoding: 'iso-8859-1',
        altText: `Scan to Open Locker #${targetLockerId}`
      });

      const buffer = await pass.asBuffer();
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', `attachment; filename=locker_${targetLockerId}.pkpass`);
      return res.send(buffer);

    } catch (error) {
      console.error('Error generating .pkpass file:', error);
      return res.status(500).send(`Server failed to compile pass: ${error.message}`);
    }
  });
});

// GET /api/access-logs (Reception desk view of audits)
app.get('/api/access-logs', authorizeReception, (req, res) => {
  db.all('SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT 100', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error reading access logs.' });
    }
    return res.json({ success: true, logs: rows });
  });
});

// GET /api/reception/config (Fetch settings)
app.get('/api/reception/config', authorizeReception, (req, res) => {
  const safeConfig = { ...config };
  if (safeConfig.MQTT_PASSWORD) {
    safeConfig.MQTT_PASSWORD = '••••••••';
  }
  return res.json({ success: true, config: safeConfig });
});

// POST /api/reception/config (Update settings)
app.post('/api/reception/config', authorizeReception, async (req, res) => {
  const newSettings = req.body;
  const allowedKeys = ['MQTT_BROKER', 'MQTT_PORT', 'MQTT_USER', 'MQTT_PASSWORD', 'BASE_URL', 'RECEPTION_PIN', 'MQTT_TOPIC_TEMPLATE'];
  
  try {
    const dbPromises = [];
    
    for (const key of allowedKeys) {
      if (newSettings[key] !== undefined) {
        let value = newSettings[key];
        
        // If password is sent as mask, don't overwrite
        if (key === 'MQTT_PASSWORD' && value === '••••••••') {
          continue;
        }

        dbPromises.push(new Promise((resolve, reject) => {
          db.run(
            'REPLACE INTO settings (key, value) VALUES (?, ?)',
            [key, value],
            (err) => {
              if (err) reject(err);
              else resolve();
            }
          );
        }));
      }
    }
    
    await Promise.all(dbPromises);
    
    // Reload settings
    await loadSettingsFromDb();
    
    // Reconnect MQTT client
    connectMQTT();
    
    return res.json({ success: true, message: 'System configuration updated and reloaded successfully.' });
  } catch (err) {
    console.error('Failed to update config in database:', err);
    return res.status(500).json({ success: false, message: `Failed to save configuration: ${err.message}` });
  }
});

// ----------------- NEW PORTAL & OVERRIDE APIS -----------------

// POST /api/reception/generate-override (PIN authorized)
app.post('/api/reception/generate-override', authorizeReception, (req, res) => {
  const { lockerId } = req.body;
  if (!lockerId) {
    return res.status(400).json({ success: false, message: 'Locker ID is required.' });
  }

  // Generate a random 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Date.now() + 60000; // 60 seconds validity
  
  overrideTokens.set(code, { lockerId, expiresAt });
  
  console.log(`Generated override token for locker ${lockerId}: ${code} (Expires in 60s)`);
  return res.json({ success: true, code, expiresAt });
});

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
            return res.status(404).json({
              success: false,
              message: 'No active locker assignment found. Please scan your pass at the locker room terminal first.'
            });
          }

          return res.json({
            success: true,
            member: {
              id: member.id,
              first_name: member.first_name,
              last_name: member.last_name
            },
            lockerId: assignment.locker_id,
            token: assignment.locker_token
          });
        }
      );
    }
  );
});

// POST /api/member/unlock (Geofenced with Override Code Fallback)
app.post('/api/member/unlock', (req, res) => {
  const { lockerId, token, lat, lon, overrideToken } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!lockerId || !token) {
    return res.status(400).json({ success: false, message: 'Locker ID and token are required.' });
  }

  // Validate the assignment token matches the occupied locker
  db.get(
    'SELECT * FROM lockers WHERE id = ? AND status = "occupied" AND access_token = ?',
    [lockerId, token],
    async (err, locker) => {
      if (err || !locker) {
        return res.status(403).json({ success: false, message: 'Access Denied: Invalid or expired locker session.' });
      }

      // Check if geolocation is missing/denied/failed
      if (lat === undefined || lon === undefined || lat === null || lon === null) {
        if (!overrideToken) {
          return res.status(403).json({
            success: false,
            gpsError: true,
            message: 'Location required. Please enable location services, or request a 60-second override token from the front desk.'
          });
        }

        // Validate override bypass token
        const overrideData = overrideTokens.get(overrideToken.trim());
        if (overrideData && overrideData.lockerId === lockerId && Date.now() < overrideData.expiresAt) {
          // One-time use: delete code
          overrideTokens.delete(overrideToken.trim());

          triggerLockerUnlock(lockerId, 'portal_override', ip, 0, 'Unlocked via Front Desk override', (unlockErr) => {
            if (unlockErr) {
              return res.status(500).json({ success: false, message: `Failed to transmit unlock command: ${unlockErr.message}` });
            }
            return res.json({ success: true, message: `Locker #${lockerId} unlocked via Front Desk override code.` });
          });
        } else {
          return res.status(403).json({
            success: false,
            message: 'Invalid or expired Front Desk override token.'
          });
        }
      } else {
        // GPS is present: evaluate geofence proximity
        const distance = getDistance(parseFloat(lat), parseFloat(lon), GYM_LAT, GYM_LON);
        if (distance > MAX_DISTANCE_METERS) {
          console.warn(`[GEOFENCE BLOCKED] Portal unlock attempt blocked for locker #${lockerId}. Distance: ${Math.round(distance)}m`);
          await logAccess(lockerId, 'unlock_portal', 'failed_geofence', ip, 1, `Blocked by geofence (Distance: ${Math.round(distance)}m)`);
          return res.status(403).json({
            success: false,
            message: `Access Denied: You must be physically inside the gym to unlock your locker. (Distance: ${Math.round(distance)}m)`
          });
        }

        // Geofence check passed: trigger lock
        triggerLockerUnlock(lockerId, 'portal_client', ip, 0, null, (unlockErr) => {
          if (unlockErr) {
            return res.status(500).json({ success: false, message: `Failed to transmit unlock command: ${unlockErr.message}` });
          }
          return res.json({ success: true, message: `Locker #${lockerId} unlocked successfully.` });
        });
      }
    }
  );
});

// POST /api/terminal/vacate
app.post('/api/terminal/vacate', (req, res) => {
  const { locker_token } = req.body;
  if (!locker_token) {
    return res.status(400).json({ success: false, message: 'Locker token is required.' });
  }

  db.get(
    'SELECT * FROM locker_assignments WHERE locker_token = ? AND status = "allocated" LIMIT 1',
    [locker_token],
    (err, assignment) => {
      if (err) {
        return res.status(500).json({ success: false, message: 'Database error.' });
      }

      if (!assignment) {
        return res.status(404).json({ success: false, message: 'No active locker assignment found to vacate.' });
      }

      const lockerId = assignment.locker_id;
      db.serialize(() => {
        db.run('UPDATE lockers SET status = "available", access_token = NULL, assigned_at = NULL WHERE id = ?', [lockerId]);
        db.run('UPDATE locker_assignments SET status = "vacated", vacated_at = ? WHERE id = ?', [Date.now(), assignment.id]);
        logAccess(lockerId, 'manual_vacate', 'success', req.ip || 'terminal_kiosk');
      });

      return res.json({ success: true, message: `Locker ${lockerId} successfully vacated.` });
    }
  );
});

dbReady.then(async () => {
  await loadSettingsFromDb();
  connectMQTT();

  app.listen(config.PORT, () => {
    console.log(`Locker Middleware Server running on port ${config.PORT}`);
  });
});
