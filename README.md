# Motion Lab

Standalone React + Three.js motion sensor lab forked from the portfolio project.

Motion Lab pairs a phone with a desktop browser session, streams `DeviceMotion` and `DeviceOrientation` packets through a small relay, and maps the phone movement into a live 3D sword scene.

## Run locally

```bash
npm install
npm run dev
```

Open the desktop URL shown by Vite. The QR code points your phone at the matching `/motion-phone/<session>` route.

Many mobile browsers require a trusted HTTPS origin for motion sensors. The Vite config will use certificates from `.cert/motion-lab-local-key.pem` and `.cert/motion-lab-local-cert.pem` when those files exist.

## Relay

The Vite dev server includes local relay endpoints at `/api/motion/*`.

For a standalone relay process:

```bash
npm run relay
```

Useful environment variables:

- `PORT`: relay port, defaults to `8787`
- `PUBLIC_RELAY_ORIGIN`: public HTTPS relay URL
- `MOTION_ALLOWED_ORIGINS`: comma-separated allowed origins, defaults to `*`
- `MOTION_SESSION_TTL_MS`: inactive session TTL
- `MOTION_MAX_PAYLOAD_BYTES`: max packet size

For static hosting, build the frontend with a relay URL:

```bash
VITE_MOTION_RELAY_URL=https://your-relay.example.com npm run build
```

## Scripts

- `npm run dev`: Vite app with local relay middleware
- `npm run build`: production build
- `npm run preview`: preview the production build
- `npm run relay`: dependency-free Node relay server
- `npm run lint`: ESLint
