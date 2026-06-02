# Inzan Locker Bootstrap Middleware

This middleware application bridges user mobile devices to local gym lockers using standard HTTP requests and publishes MQTT commands to a local broker. It features a responsive Progressive Web App (PWA) interface, Apple Wallet (.pkpass) access capabilities, connection pooling, input validation, and connection error resiliency.

---

## Security Mitigation Guidelines

Operating IoT access systems on unencrypted local networks carries security risks (e.g., man-in-the-middle attacks, credential sniffing). Implement these recommendations to secure your infrastructure:

### 1. Secure MQTT Traffic (TLS/SSL)
By default, standard MQTT on port `1883` sends commands and credentials in plain text. If an attacker performs network sniffing on this port, they can capture the username and password.
- **Action:** Configure your Docker MQTT broker to listen on port `8883` with SSL/TLS enabled.
- **Action:** Generate server-side SSL certificates (e.g., using Let's Encrypt or a local CA trust).
- **Action:** Update your `.env` configuration to use `mqtts://` protocol and port `8883`.

### 2. Protect Docker Container Secrets
If attackers gain administrative access to the Docker host, they can view environment variables containing passwords.
- **Action:** Never hardcode passwords in the `Dockerfile`.
- **Action:** Avoid passing sensitive values directly via the command line or environment configurations. Instead, load secrets securely using a secret manager or by mounting read-only volume secrets (e.g., Docker Secrets) into the container.
- **Action:** Enforce strict access control lists (ACLs) on the MQTT broker configuration, permitting only specific client IDs to publish to command topics.

---

## Deployment Instructions

You can host this middleware on a local server (e.g. Windows PC, macOS machine, or Raspberry Pi) connected to the local Wi-Fi.

### Option A: Local Process Execution
1. Install Node.js (v18 or higher) on the target machine.
2. Clone this repository into a folder.
3. Install dependencies:
   ```bash
   npm install --only=production
   ```
4. Copy `.env.example` to `.env` and fill in the required variables (specifically your broker IP `192.168.68.2`, port `1883`, username, password, and base URL).
5. Run the application:
   ```bash
   npm start
   ```

### Option B: Docker Container Execution
1. Ensure Docker is installed on the hosting server.
2. Build the Docker image:
   ```bash
   docker build -t inzan-locker-middleware .
   ```
3. Run the container, passing the required environment variables:
   ```bash
   docker run -d \
     -p 3000:3000 \
     --name locker-middleware \
     -e MQTT_BROKER="mqtt://192.168.68.2" \
     -e MQTT_PORT="1883" \
     -e MQTT_USER="mqtt" \
     -e MQTT_PASSWORD="your_broker_password" \
     -e BASE_URL="http://192.168.68.2:3000" \
     inzan-locker-middleware
   ```

---

## Verification & Testing Checklist

Use this step-by-step checklist to validate the system end-to-end:

### Step 1: Validate Backend to Broker Connectivity
1. Start the middleware server.
2. Check the console logs. Verify that the server output displays:
   `Successfully connected to MQTT Broker.`
3. If it says `MQTT Connection closed. Reconnecting...`, verify network routing between your server and the broker host (`192.168.68.2`), and double-check credentials.

### Step 2: Validate API Dispatch
1. Using an API testing client (e.g., Postman) or a `curl` command, send a mock POST request:
   ```bash
   curl -X POST http://localhost:3000/api/unlock-locker \
     -H "Content-Type: application/json" \
     -d '{"lockerId": 14}'
   ```
2. Verify that the response returns `{"success": true}`.
3. Review backend logs to confirm that the command was successfully published to the topic `gym/lockers/14/command`.

### Step 3: Validate Mobile Web Interface
1. Navigate to the server URL on a mobile device or browser with a locker query parameter, e.g.:
   `http://<SERVER_IP>:3000/?locker=14`
2. Confirm that the page loads with a digital pass styling, displaying "LOCKER NUMBER #14" and a blue "Tap to Unlock Locker #14" button.
3. Tap the button. Verify:
   - Button shows "Transmitting Command..." and spinning indicator.
   - Status badge changes to "DISPATCHING".
   - Upon successful server response, the badge changes to green "UNLOCKED", a success notification displays, and the phone vibrates (if supported).
   - After 5 seconds, the status returns to "LOCKED".
