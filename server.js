const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Serve static frontend files from public directory
app.use(express.static('public'));

// Retrieve configurations from environment
const MQTT_BROKER = process.env.MQTT_BROKER || 'mqtt://192.168.68.2';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_USER = process.env.MQTT_USER || 'mqtt';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_TOPIC_TEMPLATE = process.env.MQTT_TOPIC_TEMPLATE || 'gym/lockers/{id}/command';

// Connection options for MQTT Broker
const mqttOptions = {
  port: MQTT_PORT,
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  reconnectPeriod: 5000, // Attempt reconnection every 5 seconds if disconnected
  connectTimeout: 30 * 1000, // Timeout after 30 seconds
};

console.log(`Connecting to MQTT Broker at ${MQTT_BROKER}:${MQTT_PORT}...`);
const mqttClient = mqtt.connect(MQTT_BROKER, mqttOptions);

mqttClient.on('connect', () => {
  console.log('Successfully connected to MQTT Broker.');
});

mqttClient.on('error', (err) => {
  console.error('MQTT Client Error:', err.message);
});

mqttClient.on('close', () => {
  console.warn('MQTT Connection closed. Reconnecting...');
});

// Endpoint to unlock a specific locker
app.post('/api/unlock-locker', (req, res) => {
  const { lockerId } = req.body;

  // Simple input validation to prevent arbitrary injection
  if (!lockerId || isNaN(parseInt(lockerId, 10))) {
    return res.status(400).json({
      success: false,
      message: 'Invalid or missing Locker ID. It must be a valid number.'
    });
  }

  const cleanLockerId = parseInt(lockerId, 10).toString();

  if (!mqttClient.connected) {
    return res.status(503).json({
      success: false,
      message: 'Middleware cannot connect to MQTT Broker. Please check connection and try again.'
    });
  }

  // Generate payload and dynamic topic structure
  const topic = MQTT_TOPIC_TEMPLATE.replace('{id}', cleanLockerId);
  const payload = JSON.stringify({
    action: 'unlock',
    id: parseInt(cleanLockerId, 10),
    timestamp: Date.now()
  });

  console.log(`Publishing payload to topic [${topic}]:`, payload);

  mqttClient.publish(topic, payload, { qos: 1 }, (error) => {
    if (error) {
      console.error(`Failed to publish unlock signal for locker ${cleanLockerId}:`, error);
      return res.status(500).json({
        success: false,
        message: 'Failed to transmit unlock command to local broker.'
      });
    }

    console.log(`Successfully dispatched unlock command for locker ${cleanLockerId}.`);
    return res.status(200).json({
      success: true,
      message: `Unlock signal dispatched successfully for locker ${cleanLockerId}.`
    });
  });
});

// Endpoint to generate an Apple Wallet Pass (.pkpass) for a specific locker
app.get('/api/generate-pass', async (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const { PKPass } = require('passkit-generator');

  const lockerId = req.query.locker;

  if (!lockerId || isNaN(parseInt(lockerId, 10))) {
    return res.status(400).send('Invalid locker ID provided.');
  }

  const cleanLockerId = parseInt(lockerId, 10).toString();
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const unlockUrl = `${baseUrl}/?locker=${cleanLockerId}`;

  // Paths to certificates
  const wwdrPath = process.env.APPLE_WWDR_CERT_PATH || 'certs/wwdr.pem';
  const passCertPath = process.env.APPLE_PASS_CERT_PATH || 'certs/pass.pem';
  const passKeyPath = process.env.APPLE_PASS_KEY_PATH || 'certs/pass.key';
  const passKeyPassword = process.env.APPLE_PASS_KEY_PASSWORD || '';

  // Check if credentials exist. If not, return a mock description and explanation
  const certsExist = fs.existsSync(wwdrPath) && fs.existsSync(passCertPath) && fs.existsSync(passKeyPath);

  if (!certsExist) {
    console.warn('Apple Wallet certificates are not fully configured. Returning simulated metadata.');
    return res.json({
      configured: false,
      message: 'Apple Wallet signing certificates (.pem/.key) are not configured on this server.',
      setupInstructions: {
        wwdrCertificate: 'Download from Apple Developer portal and save to certs/wwdr.pem',
        passCertificate: 'Export Pass Type ID certificate as PEM to certs/pass.pem',
        privateKey: 'Export Pass private key as PEM to certs/pass.key',
        environment: 'Update APPLE_PASS_TYPE_IDENTIFIER and APPLE_TEAM_IDENTIFIER in your .env file.'
      },
      mockPassData: {
        passType: 'generic',
        organizationName: 'Inzan Gym Locker System',
        description: `Access Pass for Gym Locker #${cleanLockerId}`,
        logoText: 'GYM LOCKER ACCESS',
        barcode: {
          format: 'PKBarcodeFormatQR',
          message: unlockUrl,
          messageEncoding: 'iso-8859-1',
          altText: `Locker #${cleanLockerId} - Tap to scan or open`
        },
        primaryFields: [
          {
            key: 'lockerId',
            label: 'LOCKER NUMBER',
            value: `#${cleanLockerId}`
          }
        ],
        backFields: [
          {
            key: 'unlockInstructions',
            label: 'Instructions',
            value: 'Scan this QR code with your camera or tap the link to unlock your locker directly.'
          },
          {
            key: 'unlockUrl',
            label: 'Unlock Link',
            value: unlockUrl
          }
        ]
      }
    });
  }

  try {
    // Read certificates
    const wwdr = fs.readFileSync(wwdrPath);
    const signerCert = fs.readFileSync(passCertPath);
    const signerKey = fs.readFileSync(passKeyPath);

    // Initialize Pass Kit generator
    const pass = new PKPass({
      // Read templates or provide them dynamically
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

    // Populate pass metadata
    pass.setPassTypeIdentifier(process.env.APPLE_PASS_TYPE_IDENTIFIER);
    pass.setTeamIdentifier(process.env.APPLE_TEAM_IDENTIFIER);
    pass.setOrganizationName('Gym Lockers');
    pass.setDescription(`Locker Access Pass - #${cleanLockerId}`);

    // Build the pass JSON structure
    pass.fields.generic = {
      primaryFields: [
        {
          key: 'lockerId',
          label: 'LOCKER NO',
          value: `#${cleanLockerId}`
        }
      ],
      secondaryFields: [
        {
          key: 'status',
          label: 'STATUS',
          value: 'ACTIVE'
        }
      ],
      auxiliaryFields: [
        {
          key: 'instruction',
          label: 'INSTRUCTION',
          value: 'Scan QR at Locker'
        }
      ],
      backFields: [
        {
          key: 'info',
          label: 'Support Info',
          value: 'This digital pass allows you to open your locker directly. Tap the URL below or scan the QR code to open your locker.'
        },
        {
          key: 'url',
          label: 'Manual Unlock Link',
          value: unlockUrl
        }
      ]
    };

    // Add barcode (QR code linking to the unlock web interface URL)
    pass.setBarcodes({
      format: 'PKBarcodeFormatQR',
      message: unlockUrl,
      messageEncoding: 'iso-8859-1',
      altText: `Scan to Unlock Locker #${cleanLockerId}`
    });

    // Compile the pass into a binary buffer
    const buffer = await pass.asBuffer();

    // Set headers to trigger wallet download on iPhone
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename=locker_${cleanLockerId}.pkpass`);
    return res.send(buffer);

  } catch (error) {
    console.error('Error generating .pkpass file:', error);
    return res.status(500).send(`Server failed to compile pass: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`Locker Middleware Server running on port ${PORT}`);
});
