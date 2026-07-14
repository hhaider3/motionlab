# Motion Lab

Turn a phone into a real-time motion controller for a browser-based 3D sword game.

Motion Lab pairs a desktop and phone with a QR code, streams `DeviceMotion` and `DeviceOrientation` data through a lightweight relay, and maps the phone's movement to a Three.js sword. Slice incoming blocks, track hits and misses, and feel successful cuts through phone vibration feedback.

[View Motion Lab in Hasan Haider's portfolio](https://hhaider3.github.io/)

## Highlights

- QR-based pairing with a unique session ID
- Live orientation, acceleration, rotation, packet-rate, and latency telemetry
- WebSocket sensor streaming with automatic HTTP fallback
- Three.js sword scene with bloom, slash trails, procedural blocks, slicing, and scoring
- Phone vibration feedback when a block is cut
- Calibration and session-reset controls
- Built-in relay middleware during Vite development
- Dependency-free Node relay for production hosting

## How it works

```text
Phone browser
  DeviceMotion + DeviceOrientation
        │
        │ WebSocket (preferred) or HTTP POST
        ▼
Motion relay ───────── Server-Sent Events ─────────► Desktop browser
        ▲                                                   │
        └────────────── hit feedback ───────────────────────┘
                            │
                            ▼
                     phone vibration
```

Sessions are held in relay memory and identified by the ID embedded in the QR link. The relay does not persist sensor packets to disk. Inactive production sessions are removed after the configured TTL.

## Requirements

- Node.js `^20.19.0` or `>=22.12.0`
- npm
- A desktop browser with WebGL
- A phone browser that exposes motion or orientation events
- A trusted HTTPS origin for phone sensor access in most mobile browsers

## Quick start

Install dependencies and start the Vite development server:

```bash
npm ci
npm run dev
```

Vite listens on all network interfaces and prints local and LAN URLs.

1. Open the desktop URL on a computer.
2. Scan the displayed QR code with a phone.
3. Hold the phone straight and vertical with its top edge facing up.
4. Tap **Start sensors** and approve motion access if prompted.
5. Move the phone to control the sword.

The desktop experience is intentionally designed for screens wider than 760 px. The paired phone uses its own focused sensor interface.

## Local HTTPS

Mobile browsers commonly block motion sensors on untrusted HTTP pages. Vite automatically enables HTTPS when both of these files exist:

```text
.cert/motion-lab-local-key.pem
.cert/motion-lab-local-cert.pem
```

Create a locally trusted certificate that covers `localhost` and the LAN address used by the phone, place it at those paths, then restart `npm run dev`. The `.cert` directory is ignored by Git.

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Desktop Motion Lab and 3D scene |
| `#/motion-phone/<session-id>` | Generated phone controller route |
| `/motion-phone/<session-id>` | Path-based phone controller route |

The generated QR code uses the hash route so it works on static hosts without server-side route rewrites.

## Relay

During development, the Vite plugin in `vite.config.js` serves the motion endpoints on the same origin as the frontend.

For a separate relay process:

```bash
npm run relay
```

The default relay address is `http://localhost:8787`.

### Relay endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Health and in-memory session count |
| `GET` | `/api/motion/config` | Public relay and security metadata |
| `GET` | `/api/motion/events?s=<session-id>` | Desktop sensor stream over SSE |
| `POST` | `/api/motion/publish` | HTTP fallback for phone sensor packets |
| `POST` | `/api/motion/feedback` | Sends hit feedback to the paired phone |
| `WS` | `/api/motion/socket?s=<session-id>` | Preferred phone sensor stream |

### Relay environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | Relay HTTP port |
| `PUBLIC_RELAY_ORIGIN` | Request origin | Public HTTPS origin reported to clients |
| `MOTION_ALLOWED_ORIGINS` | `*` | Comma-separated frontend origins allowed by CORS and WebSocket checks |
| `MOTION_SESSION_TTL_MS` | `1800000` | Inactive session lifetime in milliseconds |
| `MOTION_MAX_PAYLOAD_BYTES` | `200000` | Maximum HTTP or WebSocket payload size |

For a public deployment, set a narrow `MOTION_ALLOWED_ORIGINS` list instead of leaving the default wildcard.

## Production deployment

The frontend is static, but phone-to-desktop communication requires the Node relay to remain online.

### 1. Deploy the relay

Run `server/motion-relay-server.mjs` on a host that supports a persistent Node HTTP process and WebSocket upgrades:

```bash
PORT=8787 \
PUBLIC_RELAY_ORIGIN=https://relay.example.com \
MOTION_ALLOWED_ORIGINS=https://motion.example.com \
npm run relay
```

Use HTTPS in production so the corresponding WebSocket connection can use `wss://` and phone browsers can expose sensor APIs.

### 2. Build the frontend

Point the static frontend at the deployed relay during the build:

```bash
VITE_MOTION_RELAY_URL=https://relay.example.com npm run build
```

Publish the generated `dist/` directory to a static host. The current Vite configuration uses `base: '/'`, so it assumes the app is served from the host's root path.

You can override the relay at runtime without rebuilding:

```text
https://motion.example.com/?relay=https%3A%2F%2Frelay.example.com
```

When the frontend and relay use different origins, the generated phone link automatically carries the relay override.

## Available scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start Vite with the local motion relay middleware |
| `npm run relay` | Start the standalone production relay |
| `npm run build` | Create an optimized frontend build in `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run ESLint across the project |

## Project structure

```text
.
├── public/
│   └── favicon.svg
├── server/
│   ├── motion-relay-server.mjs  # Standalone HTTP, SSE, and WebSocket relay
│   └── websocket-relay.mjs      # WebSocket handshake, framing, and parser helpers
├── src/
│   ├── components/
│   │   └── MotionLab.jsx        # Desktop scene and phone controller
│   ├── utils/
│   │   └── qrCode.js            # QR path generation
│   ├── App.jsx                  # Desktop/phone route selection
│   ├── index.css
│   └── main.jsx
├── vite.config.js               # Vite config and development relay
└── package.json
```

## Troubleshooting

### The phone says HTTPS is required

Open the phone page from a trusted HTTPS URL. A certificate trusted only by the desktop may still be rejected by the phone.

### The phone has no motion data

- Confirm the browser supports `DeviceMotionEvent` or `DeviceOrientationEvent`.
- Tap **Start sensors** from a direct user gesture.
- Approve the motion permission prompt.
- Check the operating system's motion, orientation, and browser privacy settings.

### The relay is unavailable

- Open the relay's `/health` endpoint.
- Confirm `PUBLIC_RELAY_ORIGIN` uses the externally reachable HTTPS URL.
- Include the frontend's exact scheme, hostname, and port in `MOTION_ALLOWED_ORIGINS`.
- Verify the host permits WebSocket upgrades and long-lived SSE connections.

### The phone streams but the desktop stays disconnected

Confirm both pages use the same session ID and relay origin. Reset the session from the desktop and scan the new QR code if needed.

### Hit vibration does not work

Vibration support varies by browser and device. Sensor control and scoring continue to work when the Vibration API is unavailable.

## Technology

- React 19
- Three.js
- Vite 8
- Lucide React
- QR Code Generator
- Node.js HTTP, Server-Sent Events, and WebSockets
