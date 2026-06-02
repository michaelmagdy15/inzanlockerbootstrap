const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '../certs');
if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

console.log('--- IoT Middleware SSL/TLS Certificate Generator ---');

function checkOpenSSL() {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch (err) {
    console.error('Error: "openssl" binary is not found in your system PATH.');
    console.log('For Windows: Please install Git for Windows (includes OpenSSL) or download OpenSSL binaries.');
    console.log('For macOS/Linux: Run "brew install openssl" or "sudo apt-get install openssl".');
    return false;
  }
}

function generateCertificates() {
  if (!checkOpenSSL()) {
    console.log('\nGenerating mock certificates for local testing fallback...');
    // Write placeholder keys to allow process boot in development
    fs.writeFileSync(path.join(certsDir, 'server.key'), 'MOCK_PRIVATE_KEY');
    fs.writeFileSync(path.join(certsDir, 'server.crt'), 'MOCK_CERTIFICATE');
    console.log('Mock certs created. Note: Use real OpenSSL certificates for production deployment.');
    return;
  }

  try {
    console.log('1. Generating Root CA Certificate Key...');
    execSync(
      `openssl genrsa -out "${path.join(certsDir, 'ca.key')}" 2048`,
      { stdio: 'inherit' }
    );

    console.log('2. Generating Root CA Certificate...');
    execSync(
      `openssl req -x509 -new -nodes -key "${path.join(certsDir, 'ca.key')}" -sha256 -days 3650 -out "${path.join(certsDir, 'ca.pem')}" -subj "/CN=InzanAthleticsCA"`,
      { stdio: 'inherit' }
    );

    console.log('3. Generating Server Private Key...');
    execSync(
      `openssl genrsa -out "${path.join(certsDir, 'server.key')}" 2048`,
      { stdio: 'inherit' }
    );

    console.log('4. Generating Server Certificate Signing Request (CSR)...');
    execSync(
      `openssl req -new -key "${path.join(certsDir, 'server.key')}" -out "${path.join(certsDir, 'server.csr')}" -subj "/CN=192.168.68.2"`,
      { stdio: 'inherit' }
    );

    console.log('5. Signing Server Certificate using Root CA...');
    execSync(
      `openssl x509 -req -in "${path.join(certsDir, 'server.csr')}" -CA "${path.join(certsDir, 'ca.pem')}" -CAkey "${path.join(certsDir, 'ca.key')}" -CAcreateserial -out "${path.join(certsDir, 'server.crt')}" -days 825 -sha256`,
      { stdio: 'inherit' }
    );

    // Clean up temporary CSR files
    const csrFile = path.join(certsDir, 'server.csr');
    const srlFile = path.join(certsDir, 'ca.srl');
    if (fs.existsSync(csrFile)) fs.unlinkSync(csrFile);
    if (fs.existsSync(srlFile)) fs.unlinkSync(srlFile);

    console.log('\n--- SUCCESS: SSL/TLS Certificates generated in /certs ---');
    console.log(`- Root CA Certificate: ${path.join(certsDir, 'ca.pem')}`);
    console.log(`- Server Private Key:  ${path.join(certsDir, 'server.key')}`);
    console.log(`- Server Certificate:  ${path.join(certsDir, 'server.crt')}`);
  } catch (error) {
    console.error('Failed to generate certificates:', error.message);
  }
}

generateCertificates();
