const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const configPath = path.join(__dirname, 'tunnel_config.json');

// Check if config file exists
if (!fs.existsSync(configPath)) {
  console.error('\x1b[31mError: tunnel_config.json not found!\x1b[0m');
  console.log('Please make sure tunnel_config.json exists in the same directory as this script.');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error('\x1b[31mError: Failed to parse tunnel_config.json!\x1b[0m');
  console.error(err.message);
  process.exit(1);
}

const { pinggy_token, local_broker_host, local_broker_port } = config;

if (!pinggy_token || pinggy_token === 'YOUR_PINGGY_TOKEN_HERE') {
  console.log('\n\x1b[33m┌────────────────────────────────────────────────────────┐');
  console.log('│             PINGGY PRO TUNNEL SETUP REQUIRED           │');
  console.log('└────────────────────────────────────────────────────────┘\x1b[0m');
  console.log('Please update \x1b[36mtunnel_config.json\x1b[0m with your Pinggy token.');
  console.log('\nTo get a token:');
  console.log('1. Go to \x1b[4mhttps://pinggy.io/\x1b[0m and sign up.');
  console.log('2. Upgrade to a paid plan to reserve a static/persistent port.');
  console.log('3. Copy your token from the dashboard.');
  console.log('4. Insert the token into \x1b[36mtunnel_config.json\x1b[0m.');
  console.log('5. Update the Cloud Run settings with your reserved port.\n');
  process.exit(1);
}

console.log('\x1b[32m┌────────────────────────────────────────────────────────┐');
console.log('│             INZAN LOCKER MIDDLEWARE TUNNEL             │');
console.log('└────────────────────────────────────────────────────────┘\x1b[0m');
console.log(`Local Broker:  \x1b[36mmqtt://${local_broker_host}:${local_broker_port}\x1b[0m`);
console.log(`Pinggy Token:  \x1b[36m${pinggy_token.substring(0, 8)}... (secured)\x1b[0m`);
console.log('System OS:    ', os.type(), `(${os.platform()})`);
console.log('----------------------------------------------------------');

let sshProcess = null;
let reconnectTimeout = null;

function startTunnel() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  const isWin = os.platform() === 'win32';
  const knownHostsFile = isWin ? 'NUL' : '/dev/null';

  console.log(`[${new Date().toLocaleTimeString()}] Connecting to Pinggy...`);

  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', `UserKnownHostsFile=${knownHostsFile}`,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-p', '443',
    '-R', `0:${local_broker_host}:${local_broker_port}`,
    `${pinggy_token}@a.pinggy.io`
  ];

  sshProcess = spawn('ssh', args);

  sshProcess.stdout.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(text);
  });

  sshProcess.stderr.on('data', (data) => {
    const text = data.toString();
    process.stdout.write(`\x1b[90m[SSH Info] ${text.trim()}\x1b[0m\n`);
  });

  sshProcess.on('error', (err) => {
    console.error(`\x1b[31m[Error] Failed to start SSH process:\x1b[0m`, err.message);
    if (err.code === 'ENOENT') {
      console.log('\x1b[31mMake sure you have an SSH client installed and available in your system PATH.\x1b[0m');
    }
  });

  sshProcess.on('close', (code) => {
    console.log(`\n\x1b[33m[${new Date().toLocaleTimeString()}] Tunnel connection closed (Code: ${code}).\x1b[0m`);
    sshProcess = null;
    
    console.log('Reconnecting in 5 seconds...');
    reconnectTimeout = setTimeout(startTunnel, 5000);
  });
}

// Handle process termination cleanly
process.on('SIGINT', () => {
  console.log('\nGracefully shutting down...');
  if (sshProcess) {
    sshProcess.kill();
  }
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  process.exit(0);
});

// Start connection
startTunnel();
