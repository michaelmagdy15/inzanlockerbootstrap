const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./database');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'inzan_athletics_super_secret_key_123';

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve static frontend files
app.use(express.static('public'));

// MQTT Settings
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://192.168.68.2';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_USER = process.env.MQTT_USER || 'mqtt';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC_TEMPLATE = process.env.MQTT_TOPIC_TEMPLATE || 'gym/lockers/{id}/command';

const mqttOptions = {
  port: MQTT_PORT,
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  reconnectPeriod: 5000,
  connectTimeout: 30 * 1000,
};

console.log(`Connecting to MQTT Broker at ${MQTT_BROKER}:${MQTT_PORT}...`);
const mqttClient = mqtt.connect(MQTT_BROKER, mqttOptions);

mqttClient.on('connect', () => {
  console.log('Successfully connected to MQTT Broker.');
});
mqttClient.on('error', (err) => {
  console.error('MQTT Client Error:', err.message);
});

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. Token is missing.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid or expired access token.' });
    }
    req.user = user;
    next();
  });
}

// Helper: Log Access Attempt and check for anomalies
function logAccess(userId, username, lockerId, action, status, ip, isFlagged = 0, flagReason = null) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO access_logs (user_id, username, locker_id, action, status, ip_address, timestamp, is_flagged, flag_reason) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, username, lockerId, action, status, ip, Date.now(), isFlagged, flagReason],
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

// ----------------- AUTHENTICATION API -----------------

// POST /api/auth/register
app.post('/api/auth/register', (req, res) => {
  const { username, password, assignedLocker } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  const lockerNum = assignedLocker ? parseInt(assignedLocker, 10) : null;
  const passwordHash = bcrypt.hashSync(password, 10);

  db.run(
    'INSERT INTO users (username, password_hash, role, assigned_locker) VALUES (?, ?, ?, ?)',
    [username, passwordHash, 'member', lockerNum],
    (err) => {
      if (err) {
        if (err.message.includes('UNIQUE constraint failed')) {
          return res.status(400).json({ success: false, message: 'Username already exists.' });
        }
        return res.status(500).json({ success: false, message: 'Database error registering member.' });
      }
      return res.status(201).json({ success: true, message: 'Member registered successfully.' });
    }
  );
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password are required.' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database query error.' });
    }

    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials.' });
    }

    // Generate JWT token containing user details
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role, assignedLocker: user.assigned_locker },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(200).json({
      success: true,
      message: 'Authentication successful.',
      token,
      user: {
        username: user.username,
        role: user.role,
        assignedLocker: user.assigned_locker
      }
    });
  });
});

// GET /api/auth/profile
app.get('/api/auth/profile', authenticateToken, (req, res) => {
  // Retrieve profile details
  res.json({
    success: true,
    user: {
      username: req.user.username,
      role: req.user.role,
      assignedLocker: req.user.assignedLocker
    }
  });
});

// ----------------- LOCKER OPERATION API -----------------

// POST /api/unlock-locker
app.post('/api/unlock-locker', authenticateToken, async (req, res) => {
  const { lockerId } = req.body;
  const ip = req.ip || req.connection.remoteAddress;

  if (!lockerId || isNaN(parseInt(lockerId, 10))) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or missing Locker ID.'
    });
  }

  const targetLockerId = parseInt(lockerId, 10);
  const { id: userId, username, role, assignedLocker } = req.user;

  // Authorization Check: standard members can only unlock their assigned locker
  if (role !== 'admin' && assignedLocker !== targetLockerId) {
    await logAccess(userId, username, targetLockerId, 'unlock', 'forbidden', ip, 1, 'Unauthorized locker access attempt');
    return res.status(403).json({
      success: false,
      message: `Access denied. You are only authorized to unlock locker #${assignedLocker}.`
    });
  }

  // Anomaly Detection: Rate limit access attempts (e.g. >3 unlock commands within 60 seconds)
  const sixtySecondsAgo = Date.now() - 60000;
  db.get(
    `SELECT COUNT(*) as recentAttempts FROM access_logs 
     WHERE user_id = ? AND timestamp > ?`,
    [userId, sixtySecondsAgo],
    async (err, row) => {
      if (err) {
        console.error('Failed to audit recent attempts count:', err.message);
      }

      const recentAttempts = row ? row.recentAttempts : 0;
      let isFlagged = 0;
      let flagReason = null;

      if (recentAttempts >= 3) {
        isFlagged = 1;
        flagReason = 'Excessive rapid unlock attempts (Rate-limiting anomaly detected)';
        console.warn(`[ANOMALY ALERT] User "${username}" flagged for excessive attempts on locker #${targetLockerId}.`);
      }

      if (!mqttClient.connected) {
        await logAccess(userId, username, targetLockerId, 'unlock', 'failed_no_broker', ip, isFlagged, flagReason);
        return res.status(503).json({
          success: false,
          message: 'Middleware cannot connect to MQTT Broker. Please check connection.'
        });
      }

      // Generate MQTT parameters
      const topic = MQTT_TOPIC_TEMPLATE.replace('{id}', targetLockerId.toString());
      const payload = JSON.stringify({
        action: 'unlock',
        id: targetLockerId,
        operator: username,
        timestamp: Date.now()
      });

      mqttClient.publish(topic, payload, { qos: 1 }, async (error) => {
        if (error) {
          console.error(`Failed to publish unlock signal for locker ${targetLockerId}:`, error);
          await logAccess(userId, username, targetLockerId, 'unlock', 'failed_broker_error', ip, isFlagged, flagReason);
          return res.status(500).json({
            success: false,
            message: 'Failed to transmit unlock command to local broker.'
          });
        }

        await logAccess(userId, username, targetLockerId, 'unlock', 'success', ip, isFlagged, flagReason);

        let warningMessage = undefined;
        if (isFlagged) {
          warningMessage = 'Unlock dispatched, but rate anomaly flagged for administrative review.';
        }

        return res.status(200).json({
          success: true,
          message: warningMessage || `Unlock command dispatched successfully for locker #${targetLockerId}.`
        });
      });
    }
  );
});

// GET /api/generate-pass (Requires JWT authorization)
app.get('/api/generate-pass', authenticateToken, async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const { PKPass } = require('passkit-generator');

  const lockerId = req.query.locker;

  if (!lockerId || isNaN(parseInt(lockerId, 10))) {
    return res.status(400).send('Invalid locker ID provided.');
  }

  const targetLockerId = parseInt(lockerId, 10);
  const { role, assignedLocker } = req.user;

  // Authorization Check
  if (role !== 'admin' && assignedLocker !== targetLockerId) {
    return res.status(403).send('Forbidden. You cannot download passes for unassigned lockers.');
  }

  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const unlockUrl = `${baseUrl}/?locker=${targetLockerId}`;

  const wwdrPath = process.env.APPLE_WWDR_CERT_PATH || 'certs/wwdr.pem';
  const passCertPath = process.env.APPLE_PASS_CERT_PATH || 'certs/pass.pem';
  const passKeyPath = process.env.APPLE_PASS_KEY_PATH || 'certs/pass.key';
  const passKeyPassword = process.env.APPLE_PASS_KEY_PASSWORD || '';

  const certsExist = fs.existsSync(wwdrPath) && fs.existsSync(passCertPath) && fs.existsSync(passKeyPath);

  if (!certsExist) {
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
      ]
    };

    pass.setBarcodes({
      format: 'PKBarcodeFormatQR',
      message: unlockUrl,
      messageEncoding: 'iso-8859-1',
      altText: `Scan to Unlock Locker #${targetLockerId}`
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

// GET /api/access-logs (Admin Only view)
app.get('/api/access-logs', authenticateToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Forbidden. Admin authorization required.' });
  }

  db.all('SELECT * FROM access_logs ORDER BY timestamp DESC LIMIT 200', [], (err, rows) => {
    if (err) {
      return res.status(500).json({ success: false, message: 'Database error reading access logs.' });
    }
    return res.json({ success: true, logs: rows });
  });
});

app.listen(PORT, () => {
  console.log(`Locker Middleware Server running on port ${PORT}`);
});
