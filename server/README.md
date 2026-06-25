# Motion Relay Backend

Tiny dependency-free Node relay for Motion Lab.

## Run Locally

```bash
npm run relay
```

Default URL:

```text
http://localhost:8787
```

## Endpoints

- `GET /health`
- `GET /api/motion/config`
- `GET /api/motion/events?s=<session>` for Server-Sent Events
- `POST /api/motion/publish` for phone sensor packets

## Deploy

Deploy `server/motion-relay-server.mjs` anywhere that can run a Node HTTP server, such as Render, Railway, Fly.io, or a VPS.

Recommended environment:

```text
PORT=8787
PUBLIC_RELAY_ORIGIN=https://motion-lab-relay.onrender.com
MOTION_ALLOWED_ORIGINS=https://hhaider3.github.io,https://localhost:5174,http://localhost:5174
```

Then build/deploy the GitHub Pages frontend with the same relay URL:

```bash
VITE_MOTION_RELAY_URL=https://motion-lab-relay.onrender.com npm run deploy
```

You can also test without rebuilding by opening the hosted site with:

```text
https://hhaider3.github.io/?relay=https%3A%2F%2Fmotion-lab-relay.onrender.com
```
