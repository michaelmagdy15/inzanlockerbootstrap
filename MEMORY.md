# Project Memory File: Locker Middleware System

This file serves as a persistent memory record for AI agents working on the **Inzan Athletics Locker Middleware** project. It outlines the system architecture, recent improvements, current state, and guides next steps.

---

## 1. System Overview & Architecture

The Locker Middleware coordinates locker operations for **Inzan Athletics** (30 lockers total) without requiring gym members to log in or use passwords.

```
       +-----------------------------------+
       |       Gym Member Phone (PWA)      |
       +-----------------+-----------------+
                         |
                         | (HTTPS requests on 5G)
                         v
       +-----------------+-----------------+
       |      Google Cloud Run Hosting     |
       |     (Express Node.js Container)   |
       +-------+--------------------+------+
               |                    |
               | (SQLite DB query)  | (MQTT Commands over TCP)
               v                    v
       +-------+--------+   +-------+-----------------+
       |   lockers.db   |   |   Cloudflare Tunnel     |
       | (SQLite File)  |   | (Bridge to Local Net)   |
       +----------------+   +-------+-----------------+
                                    |
                                    | (Staff Wi-Fi Bridge)
                                    v
                            +-------+-----------------+
                            |  Local MQTT Broker      |
                            |  (192.168.68.2:1883)    |
                            +-------------------------+
```

### Components:
1. **Express Server (`server.js`)**: Backend routing API for client unlock requests, token validation, reception desk allocation/release, and system settings.
2. **SQLite Database (`lockers.db` managed by `database.js`)**:
   - `lockers`: Stores locker ID (1-30), status (available/occupied), token, and allocation timestamp.
   - `access_logs`: Tracks client operations, flagging rate-limit anomalies.
   - `settings`: Stores dynamic configuration values that override environment variables.
3. **Gym Member UI (`public/index.html`)**: Mobile-responsive zero-login PWA. Automatically caches assigned credentials in `localStorage` and includes an HTML5-based QR code camera scanner.
4. **Reception Dashboard (`public/reception.html`)**: Console showing locker statuses, assignment/release controls, Apple Wallet pass generation, and the System Settings panel.

---

## 2. Recent Implementations & Fixes

### A. QR Scanner Contrast & Decoding Fix
*   **The Issue:** The PWA's in-app camera scanner (powered by `html5-qrcode`) failed to scan the QR code displayed on the reception desk. The camera feed opened, but decoding never triggered.
*   **The Cause:** The generated QR code used light cyan (`#00f0ff`) on a dark background (`#141622`). Open-source QR code decoders require standard high-contrast dark pixels on a light background.
*   **The Solution:**
    - Modified `public/reception.html` to generate QR codes with standard high contrast (`color=141622` and `bgcolor=ffffff`).
    - Updated the `.qr-placeholder` background in `public/style.css` to `#ffffff` (white).
    - The PWA scanner now reads and associates passes instantly on mobile devices.

### B. System Configuration Panel (Reception Dashboard)
*   **The Feature:** Added a configuration interface directly in the reception panel to configure environment settings at runtime.
*   **The Backend Integration:**
    - Added the `settings` key-value table to `database.js`.
    - Integrated dynamic configuration loading in `server.js`. The server queries `settings` on startup and overrides process environment variables.
    - Exposed authenticated routes `GET /api/reception/config` and `POST /api/reception/config` (secured by the Reception PIN).
    - **Hot-reloading MQTT:** On updating broker settings, the server automatically disconnects from the old MQTT client and connects to the new target without requiring server restarts.
*   **The Frontend UI:**
    - Added a gear icon button "⚙️ System Settings" in `reception.html` (visible only after entering the PIN).
    - Created a modal form to view and edit:
      - MQTT Broker IP/URL
      - MQTT Port
      - Username & Password
      - Command Topic Template
      - Base Application URL
      - Reception dashboard authentication PIN
    - Styled the inputs to match the dark, premium glassmorphism design system.

---

## 3. Operational Guide for Future Agents

### Running the Local Dev Environment
1.  **Start Dev Server:** Run `npm run dev` to boot the Node server with hot-reload watcher.
2.  **Verify DB Init:** A new SQLite database (`lockers.db`) will initialize automatically with 30 lockers starting as `available`.
3.  **Launch Dashboard:** Open `http://localhost:3000/reception.html` in your browser.
    -   Default PIN is `1234`.
    -   Once unlocked, click the "⚙️ System Settings" button in the top right to configure the broker.

### Cloud Run Ephemeral Behavior Warning
*   Because Cloud Run container filesystem instances are ephemeral, any updates saved via the System Settings panel into `lockers.db` will reset when the container sleeps or scales down.
*   **Recommendation:** Use the System Settings panel for testing and initial verification. For production deployments, define matching environment variables in the Cloud Run configuration panel (e.g. `MQTT_BROKER`, `MQTT_PORT`, `RECEPTION_PIN`, `BASE_URL`) to ensure they persist across container scale-ups.

### Production Environment Variables List
When deploying to Cloud Run, set the following env keys:
-   `MQTT_BROKER` (e.g., `tcp://broker.inzanathletics.com` routed via Cloudflare)
-   `MQTT_PORT` (e.g., `1883`)
-   `MQTT_USER`
-   `MQTT_PASSWORD`
-   `RECEPTION_PIN` (defaults to `1234` if unset)
-   `BASE_URL` (the HTTPS public endpoint of the Cloud Run instance)

---

*Compiled on 2026-06-03 by Antigravity agent.*
