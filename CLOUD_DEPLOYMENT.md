# Google Cloud Run & Cloudflare Tunnel Deployment Guide

This guide details how to configure and deploy the **Inzan Athletics** locker middleware to **Google Cloud Run** and bridge it to your local gym MQTT broker using a secure, outbound-only **Cloudflare Tunnel**. 

This setup allows clients to scan QR codes on the physical lockers and unlock them using their smartphone's cellular data (LTE/5G), bypassing the need to connect to the gym's private staff Wi-Fi.

---

## Architecture Overview

```
[Smartphone (LTE/5G)] ---> [Google Cloud Run (Public Web App)]
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

## Step 1: Deploy Middleware to Google Cloud Run

Google Cloud Run executes containerized applications in a fully managed, public cloud environment.

1. **Verify Dockerfile:**
   Ensure the production-ready [Dockerfile](./Dockerfile) exists in the repository root.
2. **Build and Publish Container Image:**
   Submit the build to Google Artifact Registry:
   ```bash
   gcloud builds submit --tag gcr.io/YOUR_PROJECT_ID/inzan-locker-middleware
   ```
3. **Deploy Container to Cloud Run:**
   Deploy the service, allowing unauthenticated public traffic so users can access the web page:
   ```bash
   gcloud run deploy inzan-locker-middleware \
     --image gcr.io/YOUR_PROJECT_ID/inzan-locker-middleware \
     --platform managed \
     --allow-unauthenticated \
     --port 3000
   ```
4. **Note the Service URL:**
   Once successfully deployed, Google will output a public URL (e.g., `https://inzan-locker-middleware-xyz.a.run.app`). We will map this domain or reference it as your `BASE_URL`.

---

## Step 2: Establish the Cloudflare Tunnel (on local macOS Broker Host)

Instead of opening incoming ports on your gym's firewall, we install a local connector agent (`cloudflared`) on the macOS machine running the MQTT broker. It opens a secure outbound tunnel to Cloudflare.

1. **Install cloudflared on macOS:**
   Use Homebrew to install the Cloudflare Tunnel client:
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   ```
2. **Log in to Cloudflare:**
   Authenticate the local agent with your Cloudflare account:
   ```bash
   cloudflared tunnel login
   ```
   *This opens a browser window. Log in and select the domain name you wish to route (e.g., `inzanathletics.com`).*
3. **Create the Tunnel:**
   Create a new named tunnel (replace `gym-mqtt-bridge` with your preferred name):
   ```bash
   cloudflared tunnel create gym-mqtt-bridge
   ```
   *This command outputs a Tunnel ID (UUID) and generates a credentials file on your disk.*
4. **Configure the Tunnel Route:**
   Route a subdomain (e.g., `broker.inzanathletics.com`) to the local MQTT broker's port. Add this configuration to your local `~/.cloudflare/config.yml`:
   ```yaml
   tunnel: YOUR_TUNNEL_UUID
   credentials-file: /Users/YOUR_USER/.cloudflared/YOUR_TUNNEL_UUID.json

   ingress:
     - hostname: broker.inzanathletics.com
       service: tcp://127.0.0.1:1883
     - service: http_status:404
   ```
5. **Route the Subdomain in DNS:**
   Bind the tunnel mapping to your Cloudflare DNS registrar:
   ```bash
   cloudflared tunnel route dns gym-mqtt-bridge broker.inzanathletics.com
   ```
6. **Start the Tunnel Daemon:**
   Launch the tunnel. It will establish a secure, encrypted stream to the nearest Cloudflare Edge server:
   ```bash
   cloudflared tunnel run gym-mqtt-bridge
   ```

---

## Step 3: Configure Cloud Run Environment Variables

Now that your local MQTT broker is securely exposed at `broker.inzanathletics.com`, update the environment configuration variables in your Google Cloud Run dashboard:

```env
MQTT_BROKER=tcp://broker.inzanathletics.com
MQTT_PORT=1883
MQTT_USER=mqtt
MQTT_PASSWORD=your_discovered_broker_password
BASE_URL=https://inzan-locker-middleware-xyz.a.run.app
JWT_SECRET=your_secure_random_jwt_string
```

---

## Step 4: The Client "Scan-to-Open" Flow

Once your cloud service and secure tunnel are fully operational:

1. **Create Locker QR Codes:**
   Generate standard QR code labels for each gym locker linking to your Cloud Run domain with the query parameter:
   - Locker 14 QR: `https://inzan-locker-middleware-xyz.a.run.app/?locker=14`
   - Locker 15 QR: `https://inzan-locker-middleware-xyz.a.run.app/?locker=15`
2. **Stick Labels on Locker Doors:**
   Affix the labels to the front of each physical locker.
3. **Scan & Open:**
   - Members scan the QR code with their default camera app using cellular data.
   - The browser opens the middleware app page.
   - The member signs in (if their JWT has expired).
   - Once authenticated, they tap "Tap to Unlock Locker #14" on the PWA digital ticket pass.
   - The API routes to Google Cloud Run, down the Cloudflare Tunnel, and triggers the local MQTT broker to open the physical locker.
