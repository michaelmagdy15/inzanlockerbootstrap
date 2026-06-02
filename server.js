const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const crypto = require('crypto');
const { db, dbReady } = require('./database');
require('dotenv').config();

const app = express();

// Enable trust proxy for Cloud Run HTTPS resolution
app.enable('trust proxy');

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static('public'));

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

// ----------------- RECEPTION DASHBOARD API -----------------

// GET /api/reception/lockers
app.get('/api/reception/lockers', authorizeReception, (req, res) => {
  db.all('SELECT * FROM lockers ORDER BY id ASC', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error reading lockers.' });
    }
    return res.json({ success: true, lockers: rows });
  });
});

// POST /api/reception/assign (Generate Token and occupy locker)
app.post('/api/reception/assign', authorizeReception, (req, res) => {
  const { lockerId } = req.body;

  if (!lockerId || isNaN(parseInt(lockerId, 10))) {
    return res.status(400).json({ success: false, message: 'Invalid or missing Locker ID.' });
  }

  const cleanLockerId = parseInt(lockerId, 10);
  
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

  if (!lockerId || isNaN(parseInt(lockerId, 10))) {
    return res.status(400).json({ success: false, message: 'Invalid or missing Locker ID.' });
  }

  const cleanLockerId = parseInt(lockerId, 10);

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

// ----------------- CLIENT UNLOCK API -----------------

// POST /api/unlock-locker
app.post('/api/unlock-locker', (req, res) => {
  const { lockerId, token } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!lockerId || isNaN(parseInt(lockerId, 10)) || !token) {
    return res.status(400).json({
      success: false,
      message: 'Locker ID and access token are required.'
    });
  }

  const targetLockerId = parseInt(lockerId, 10);

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

    // 12-Hour Expiry Check (12 * 60 * 60 * 1000 = 43,200,000 milliseconds)
    const twelveHours = 12 * 60 * 60 * 1000;
    if (locker.assigned_at && (Date.now() - locker.assigned_at > twelveHours)) {
      // Automatically release locker on expired access attempt
      db.run(
        "UPDATE lockers SET status = 'available', access_token = NULL, assigned_at = NULL WHERE id = ?",
        [targetLockerId]
      );
      await logAccess(targetLockerId, 'unlock', 'expired', ip, 1, 'Attempted access with expired token (>12 hours)');
      return res.status(403).json({
        success: false,
        message: 'Locker assignment has expired (12-hour limit reached). Please reassign at reception.'
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

        if (!mqttClient || !mqttClient.connected) {
          await logAccess(targetLockerId, 'unlock', 'failed_no_broker', ip, isFlagged, flagReason);
          return res.status(503).json({
            success: false,
            message: 'Middleware cannot connect to MQTT Broker. Please check connection.'
          });
        }

        // Generate MQTT command parameters
        const topic = config.MQTT_TOPIC_TEMPLATE.replace('{id}', targetLockerId.toString());
        const payload = JSON.stringify({
          action: 'unlock',
          id: targetLockerId,
          operator: 'token_client',
          timestamp: Date.now()
        });

        mqttClient.publish(topic, payload, { qos: 1 }, async (error) => {
          if (error) {
            console.error(`Failed to publish unlock command for locker #${targetLockerId}:`, error);
            await logAccess(targetLockerId, 'unlock', 'failed_broker_error', ip, isFlagged, flagReason);
            return res.status(500).json({
              success: false,
              message: 'Failed to transmit unlock command to local broker.'
            });
          }

          await logAccess(targetLockerId, 'unlock', 'success', ip, isFlagged, flagReason);

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

  if (!locker || isNaN(parseInt(locker, 10)) || !token) {
    return res.status(400).json({ success: false, message: 'Locker ID and token are required.' });
  }

  const targetLockerId = parseInt(locker, 10);

  db.get('SELECT * FROM lockers WHERE id = ?', [targetLockerId], (err, lockerRow) => {
    if (err || !lockerRow) {
      return res.json({ success: true, valid: false, message: 'Locker not found.' });
    }

    if (lockerRow.status !== 'occupied' || lockerRow.access_token !== token) {
      return res.json({ success: true, valid: false, message: 'Token is invalid or locker is released.' });
    }

    // Expiry Check (12 hours)
    const twelveHours = 12 * 60 * 60 * 1000;
    if (lockerRow.assigned_at && (Date.now() - lockerRow.assigned_at > twelveHours)) {
      // Auto release expired locker in background
      db.run("UPDATE lockers SET status = 'available', access_token = NULL, assigned_at = NULL WHERE id = ?", [targetLockerId]);
      return res.json({ success: true, valid: false, message: 'Locker assignment has expired.' });
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

  if (!locker || isNaN(parseInt(locker, 10)) || !token) {
    return res.status(400).send('Locker ID and token are required.');
  }

  const targetLockerId = parseInt(locker, 10);

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

dbReady.then(async () => {
  await loadSettingsFromDb();
  connectMQTT();

  app.listen(config.PORT, () => {
    console.log(`Locker Middleware Server running on port ${config.PORT}`);
  });
});
