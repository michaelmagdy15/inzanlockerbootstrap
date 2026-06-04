# Project Memory File: Locker Middleware System

This file serves as a persistent memory record for AI agents working on the **Inzan Athletics Locker Middleware** project. It outlines the system architecture, recent improvements, current state, and guides next steps.

---

## 1. System Overview & Architecture

The Locker Middleware coordinates locker operations for **Inzan Athletics** (68 physical lockers total) without requiring gym members to log in or use passwords.

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
       |   lockers.db   |   |   Bore TCP Tunnel       |
       | (SQLite File)  |   | (Bridge to Local Net)   |
       +----------------+   +-------+-----------------+
                                    |
                                    | (Staff Wi-Fi Bridge)
                                    v
                            +-------+-----------------+
                            |  Local MQTT Broker      |
                            |  (192.168.10.31:1883)   |
                            +-------------------------+
                                    |
                                    v (Locker Pop!)
                            [Physical Lockers]
```

### Components:
1. **Express Server (`server.js`)**: Backend routing API for client unlock requests, token validation, reception desk allocation/release, and system settings.
2. **SQLite Database (`lockers.db` managed by `database.js`)**:
   - `lockers`: Stores locker ID (physical string name e.g., `'M27'`, `'F12'`), status (`available`/`occupied`/`maintenance`), token, and allocation timestamp.
   - `access_logs`: Tracks client operations, flagging rate-limit anomalies.
   - `settings`: Stores dynamic configuration values that override environment variables.
3. **Gym Member UI (`public/index.html`)**: Mobile-responsive zero-login PWA. Automatically caches assigned credentials in `localStorage` and includes an HTML5-based QR code camera scanner. Resolves parameters as string names (like `M27`).
4. **Reception Dashboard (`public/reception.html`)**: Console showing locker statuses, assignment/release controls, Apple Wallet pass generation, and the System Settings panel.
5. **Standard Configurations (`lockers_config.json`)**: Pre-seeded config of all 68 standard gym lockers (Men: `M1`–`M34`, Women: `F1`–`F34`) with their local dashboard IDs, command topics, protocols, and initial statuses.

---

## 2. Recent Implementations & Fixes

### A. Alphanumeric Locker Name Mapping
*   **The Issue:** The previous implementation used sequential integer IDs (1–32) which did not match the physical locker room labeling (`M1`–`M34` for men and `F1`–`F34` for women). Additionally, different locker models expected custom command topics and protocol formats.
*   **The Solution:**
    - Generated a static mapping [lockers_config.json](file:///c:/inzanlockers/lockers_config.json) of all 68 standard lockers from the primary local server at `http://192.168.10.31:3001/api/lockers`.
    - Upgraded the SQLite database schema to use `id TEXT PRIMARY KEY` so locker records are keyed by their physical name (e.g. `'M27'`).
    - Added database schema migration detection: if the older schema is present, the app automatically drops and recreates the tables to upgrade smoothly.
    - Updated `/api/auto-assign` to search for available lockers matching prefix patterns (`id LIKE 'M%'` or `id LIKE 'F%'`) and sort them numerically by their suffix.

### B. Dynamic Topic Resolution & Solenoid Burnout Prevention
*   **The Issue:** Solar/electromagnetic latches are only rated for momentary activation (pulsing for 1–3 seconds). Keeping a relay `"ON"` indefinitely causes the solenoid coil to draw constant current, overheat, emit a burning smell, and eventually burn out.
*   **The Solution:**
    - Integrated config lookup at unlock time. When `/api/unlock-locker` is invoked, the backend retrieves the locker's `command_topic` and `protocol` from `lockers_config.json`.
    - If the locker uses the `aywana` protocol (Home Assistant switch relay), the server:
      1. Publishes `"ON"` to the `command_topic` (to trigger the unlock).
      2. Schedules a `setTimeout` to publish `"OFF"` to the same topic exactly **2 seconds later** (releasing current to the solenoid coil safely).
    - If the locker uses the `rubik` protocol, it publishes the correct JSON command payload.

### C. TCP Tunnel Configuration
*   **Expose Tool:** EXPOSE local port `1883` to the public Cloud Run middleware using `bore`:
    ```bash
    bore.exe local 1883 --local-host 192.168.10.31 --to bore.pub
    ```
*   **Allocated Port:** Dynamic allocation bound the proxy connection at `bore.pub:59045`.
*   **Cloud Run Update:** Updated the `MQTT_PORT=59045` environment variable in Google Cloud Run to route traffic through the new tunnel.

---

## 3. Operational Guide for Future Agents

### EPHEMERAL Cloud Run SQLite Reset behavior
*   Cloud Run filesystems are ephemeral. Deploying a new revision or container restarts will reset `lockers.db` to its initial default state.
*   The database is safely seeded from `lockers_config.json` on startup.
*   Locker assignments (`access_token` and `status`) are stored in SQLite and will be reset on scale-to-zero or rollout. For persistent token caching, moving to an external database (e.g. Firestore, Cloud SQL) should be considered if traffic scales.

### Production Environment Variables List
-   `MQTT_BROKER` (e.g., `mqtt://bore.pub`)
-   `MQTT_PORT` (currently `59045` routed via bore)
-   `MQTT_USER` (set to `mqtt`)
-   `MQTT_PASSWORD` (set to `mqttpass`)
-   `RECEPTION_PIN` (defaults to `1234` if unset)
-   `BASE_URL` (`https://inzan-locker-middleware-123198087427.us-central1.run.app`)

---

*Compiled on 2026-06-04 by Antigravity agent.*
