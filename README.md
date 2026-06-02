# Inzan Locker Bootstrap Middleware

This middleware application bridges user mobile devices to local physical gym lockers at **Inzan Athletics** using standard HTTPS requests on cellular data (LTE/5G), publishing commands down to a local MQTT broker. It features a zero-login Progressive Web App (PWA) client interface, an administrative reception desk dashboard, dynamic runtime configuration persistence, and automatic 12-hour ticket auto-releases.

---

## 🚀 Core Features

1.  **Zero-Login Mobile PWA:**
    *   No member passwords or usernames required. 
    *   Automatic token credential caching in the phone's `localStorage` on initial scan.
    *   One-tap locker activation with dynamic ripple animations and haptic feedback.
2.  **In-App QR Code Scanner:**
    *   Integrated `html5-qrcode` camera scanner allowing members to scan new locker tickets on the spot.
    *   *High-Contrast Decoding:* QR codes generated on the reception dashboard use a dark-slate-on-white layout with a solid white viewport border to guarantee instant scanning on iOS and Android devices.
3.  **Automatic 12-Hour Expiry:**
    *   Server-side validation checks database allocation timestamps. Any locker token older than 12 hours is automatically released, and access is invalidated to maintain high security.
4.  **System Settings Panel (Reception Dashboard):**
    *   Administrative console (protected by a dashboard PIN) allows staff to configure configurations at runtime:
        -   MQTT Broker URL & Port
        -   MQTT Username & Password
        -   MQTT Command Topic Template
        -   Base Web App URL
        -   Desk Access PIN
    *   *Dynamic Hot-Reloading:* Configuration updates are written to an SQLite `settings` table and re-instantiated instantly, closing the old MQTT client socket and connecting to the new broker without requiring container restarts.

---

## 📦 System Architecture

```
[Smartphone (LTE/5G)] ---> [Google Cloud Run (Public Web App)]
                                      |
                                      +--- (Reads/Writes to SQLite) ---> [lockers.db]
                                      |
                                      v (MQTT TCP Connection)
                            [Cloudflare Secure Edge]
                                      |
                                      v (Outbound Secure Tunnel)
                          [cloudflared (macOS Broker Host)]
                                      |
                                      v (Local Broker TCP)
                         [Local MQTT Broker (192.168.68.2)]
                                      |
                                      v (Locker Pop!)
                             [Physical Lockers]
```

---

## 🛠️ Deployment Instructions

### 1. Local Process Execution
1.  Ensure **Node.js (v18 or higher)** is installed on the target machine.
2.  Clone the repository and install production dependencies:
    ```bash
    npm install --only=production
    ```
3.  Copy `.env.example` to `.env` and fill in initial values.
4.  Launch the hot-reload watcher server:
    ```bash
    npm run dev
    ```
5.  Access the administrative panel at `http://localhost:3000/reception.html` (default PIN is `1234`). Click the **⚙️ System Settings** button to adjust broker credentials.

### 2. Google Cloud Run Deployment
Cloud Run hosts the Express backend container publicly, allowing mobile users to access it on 5G without gym Wi-Fi connections:
1.  **Build and Publish Image:**
    ```bash
    gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/inzan-locker-middleware
    ```
2.  **Deploy Container Service:**
    ```bash
    gcloud run deploy inzan-locker-middleware \
      --image gcr.io/YOUR_PROJECT_ID/inzan-locker-middleware \
      --platform managed \
      --allow-unauthenticated \
      --port 3000
    ```
3.  *Note: Because Cloud Run filesystems are ephemeral, dynamic database settings saved to SQLite will reset during container scale-downs. For production deployments, specify your environment variables directly in your Cloud Run service configuration (e.g. `MQTT_BROKER`, `MQTT_PORT`, `BASE_URL`, `RECEPTION_PIN`).*

### 3. Setup local Cloudflare Tunnel
Install `cloudflared` on the local machine hosting your MQTT broker (`192.168.68.2`) to bridge connection requests securely without opening incoming firewall ports:
1.  **Install client:** `brew install cloudflare/cloudflare/cloudflared` (macOS)
2.  **Authenticate:** `cloudflared tunnel login`
3.  **Create tunnel:** `cloudflared tunnel create gym-mqtt-bridge`
4.  **Route tunnel DNS:** `cloudflared tunnel route dns gym-mqtt-bridge broker.inzanathletics.com`
5.  **Configure ingress (`~/.cloudflare/config.yml`):**
    ```yaml
    tunnel: YOUR_TUNNEL_UUID
    credentials-file: /Users/YOUR_USER/.cloudflared/YOUR_TUNNEL_UUID.json

    ingress:
      - hostname: broker.inzanathletics.com
        service: tcp://127.0.0.1:1883
      - service: http_status:404
    ```
6.  **Run tunnel agent:** `cloudflared tunnel run gym-mqtt-bridge`

---

## 🔐 Administrative Credentials

-   **Reception Desk URL:** `/reception.html`
-   **Default Authorization PIN:** `1234`
-   *Once authenticated, PIN code and Broker settings can be managed directly via the dashboard System Settings panel.*

---

*For detailed infrastructure build instructions and troubleshooting, reference [CLOUD_DEPLOYMENT.md](./CLOUD_DEPLOYMENT.md) and [MEMORY.md](./MEMORY.md).*
