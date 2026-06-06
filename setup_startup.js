const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const scriptPath = path.join(__dirname, 'run_tunnel.js');
const platform = os.platform();

console.log('\n\x1b[35m┌────────────────────────────────────────────────────────┐');
console.log('│           INZAN LOCKER STARTUP CONFIGURATOR            │');
console.log('└────────────────────────────────────────────────────────┘\x1b[0m');

if (platform === 'win32') {
  // Windows Setup
  const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbsPath = path.join(startupDir, 'inzan_locker_tunnel.vbs');

  // VBScript to run Node hidden (without showing an annoying black terminal window)
  const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run "node.exe \\"${scriptPath.replace(/\\/g, '\\\\')}\\"", 0, false\n`;

  try {
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    console.log(`\x1b[32m[Success]\x1b[0m Created Windows startup script at:\n  \x1b[36m${vbsPath}\x1b[0m`);
    console.log('\n\x1b[32mThe tunnel will now run silently in the background on every PC boot.\x1b[0m');
  } catch (err) {
    console.error('\x1b[31m[Error] Failed to write startup file:\x1b[0m', err.message);
  }
} else if (platform === 'darwin') {
  // macOS Setup
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }
  const plistPath = path.join(launchAgentsDir, 'com.inzan.lockertunnel.plist');

  // Find absolute path of node
  let nodePath = 'node';
  try {
    nodePath = execSync('which node').toString().trim();
  } catch (e) {
    console.warn('\x1b[33mWarning: Could not locate "node" executable path automatically. Defaulting to "node".\x1b[0m');
  }

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.inzan.lockertunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(__dirname, 'tunnel_stdout.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(__dirname, 'tunnel_stderr.log')}</string>
</dict>
</plist>`;

  try {
    fs.writeFileSync(plistPath, plistContent, 'utf8');
    console.log(`\x1b[32m[Success]\x1b[0m Created macOS LaunchAgent at:\n  \x1b[36m${plistPath}\x1b[0m`);
    
    // Unload if already loaded to prevent duplicate errors
    try {
      execSync(`launchctl unload "${plistPath}" 2>/dev/null`);
    } catch(e) {}

    // Load and register it immediately
    execSync(`launchctl load "${plistPath}"`);
    console.log('\n\x1b[32mThe tunnel has been registered and is running in the background.\x1b[0m');
    console.log('It will boot automatically on every login/startup.');
  } catch (err) {
    console.error('\x1b[31m[Error] Failed to set up startup for macOS:\x1b[0m', err.message);
  }
} else {
  console.log('\x1b[31mAutomatic startup setup is only supported on Windows and macOS.\x1b[0m');
}
console.log('----------------------------------------------------------\n');
