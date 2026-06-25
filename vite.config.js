import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import {
  acceptWebSocket,
  createWebSocketParser,
  webSocketPath,
  writeWebSocketJson,
} from './server/websocket-relay.mjs'

const certDir = path.resolve('.cert');
const httpsKeyPath = path.join(certDir, 'motion-lab-local-key.pem');
const httpsCertPath = path.join(certDir, 'motion-lab-local-cert.pem');

const getLanAddresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter(Boolean)
  .filter(address => address.family === 'IPv4' && !address.internal)
  .map(address => address.address);

const getHttpsOptions = () => {
  if (!fs.existsSync(httpsKeyPath) || !fs.existsSync(httpsCertPath)) {
    return false;
  }

  return {
    key: fs.readFileSync(httpsKeyPath),
    cert: fs.readFileSync(httpsCertPath),
  };
};

const sendJson = (res, statusCode, payload) => {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
};

const setCorsHeaders = (req, res) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
};

const readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = '';

  req.on('data', chunk => {
    body += chunk;
    if (body.length > 200_000) {
      reject(new Error('Payload too large'));
      req.destroy();
    }
  });

  req.on('end', () => {
    try {
      resolve(body ? JSON.parse(body) : {});
    } catch (error) {
      reject(error);
    }
  });

  req.on('error', reject);
});

const motionRelayPlugin = () => ({
  name: 'motion-relay',
  configureServer(server) {
    const sessions = new Map();

    const getSession = (sessionId) => {
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { clients: new Set(), lastPacket: null, publishers: new Set() });
      }

      return sessions.get(sessionId);
    };

    const getOrigins = () => {
      const serverAddress = server.httpServer?.address();
      const configuredPort = server.config.server.port;
      const port = typeof serverAddress === 'object' && serverAddress?.port
        ? serverAddress.port
        : configuredPort || 5173;
      const protocol = server.config.server.https ? 'https' : 'http';
      const lanOrigins = getLanAddresses().map(address => `${protocol}://${address}:${port}`);

      return {
        localOrigin: `${protocol}://localhost:${port}`,
        lanOrigins,
        preferredOrigin: lanOrigins[0] || `${protocol}://localhost:${port}`,
        secure: protocol === 'https',
      };
    };

    const broadcast = (sessionId, eventName, payload) => {
      const session = getSession(sessionId);
      const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;

      session.clients.forEach(client => {
        try {
          client.write(message);
        } catch {
          session.clients.delete(client);
        }
      });
    };

    const publishPacket = (sessionId, packet) => {
      const session = getSession(sessionId);
      const enrichedPacket = {
        ...packet,
        sessionId,
        relayReceivedAt: Date.now(),
      };
      session.lastPacket = enrichedPacket;
      broadcast(sessionId, 'sensor', enrichedPacket);

      return {
        packet: enrichedPacket,
        listeners: session.clients.size,
      };
    };

    const rejectUpgrade = (socket, statusCode, message) => {
      socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    const handleSocketUpgrade = (req, socket) => {
      const url = new URL(req.url || '/', 'http://motion.local');

      if (url.pathname !== webSocketPath) {
        return;
      }

      const sessionId = url.searchParams.get('s');
      if (!sessionId) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }

      if (!acceptWebSocket(req, socket)) {
        return;
      }

      const session = getSession(sessionId);
      session.publishers.add(socket);
      let lastStatsAt = 0;

      writeWebSocketJson(socket, {
        type: 'hello',
        sessionId,
        listeners: session.clients.size,
        ...getOrigins(),
      });

      const parser = createWebSocketParser({
        onText: (message) => {
          const packet = JSON.parse(message);
          const result = publishPacket(sessionId, {
            ...packet,
            sessionId,
          });
          const now = Date.now();

          if (now - lastStatsAt >= 1000) {
            lastStatsAt = now;
            writeWebSocketJson(socket, {
              type: 'stats',
              listeners: result.listeners,
              now,
            });
          }
        },
        onError: () => {
          session.publishers.delete(socket);
        },
      });

      socket.on('data', chunk => parser(chunk, socket));
      socket.on('close', () => {
        session.publishers.delete(socket);
      });
      socket.on('error', () => {
        session.publishers.delete(socket);
      });
    };

    server.httpServer?.on('upgrade', handleSocketUpgrade);

    server.middlewares.use('/api/motion', (req, res, next) => {
      setCorsHeaders(req, res);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      next();
    });

    server.middlewares.use('/api/motion/config', (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      sendJson(res, 200, getOrigins());
    });

    server.middlewares.use('/api/motion/events', (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      const url = new URL(req.url || '/', 'http://motion.local');
      const sessionId = url.searchParams.get('s');

      if (!sessionId) {
        sendJson(res, 400, { error: 'Missing session id' });
        return;
      }

      const session = getSession(sessionId);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ sessionId, ...getOrigins() })}\n\n`);

      if (session.lastPacket) {
        res.write(`event: sensor\ndata: ${JSON.stringify(session.lastPacket)}\n\n`);
      }

      session.clients.add(res);
      const keepAlive = setInterval(() => {
        res.write(`event: ping\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
      }, 15_000);

      req.on('close', () => {
        clearInterval(keepAlive);
        session.clients.delete(res);
      });
    });

    server.middlewares.use('/api/motion/publish', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      try {
        const packet = await readJsonBody(req);
        const sessionId = packet.sessionId || packet.s;

        if (!sessionId) {
          sendJson(res, 400, { error: 'Missing session id' });
          return;
        }

        const result = publishPacket(sessionId, packet);
        sendJson(res, 200, { ok: true, listeners: result.listeners });
      } catch (error) {
        sendJson(res, 400, { error: error.message || 'Invalid sensor packet' });
      }
    });
  },
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), motionRelayPlugin()],
  base: '/',
  server: {
    host: '0.0.0.0',
    https: getHttpsOptions(),
  },
  build: {
    chunkSizeWarningLimit: 550,
  },
})
