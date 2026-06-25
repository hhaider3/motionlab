import crypto from 'node:crypto';

export const webSocketPath = '/api/motion/socket';

const webSocketGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const writeFrame = (socket, opcode, payload = Buffer.alloc(0)) => {
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
};

export const writeWebSocketJson = (socket, payload) => {
  writeFrame(socket, 0x1, Buffer.from(JSON.stringify(payload)));
};

const writePong = (socket, payload) => {
  writeFrame(socket, 0xa, payload);
};

export const createWebSocketParser = ({
  maxPayloadBytes = 200_000,
  onText,
  onClose,
  onError,
}) => {
  let buffer = Buffer.alloc(0);
  let fragments = [];

  return (chunk, socket) => {
    buffer = Buffer.concat([buffer, chunk]);

    try {
      while (buffer.length >= 2) {
        const firstByte = buffer[0];
        const secondByte = buffer[1];
        const isFinal = Boolean(firstByte & 0x80);
        const opcode = firstByte & 0x0f;
        const isMasked = Boolean(secondByte & 0x80);
        let length = secondByte & 0x7f;
        let offset = 2;

        if (length === 126) {
          if (buffer.length < offset + 2) {
            return;
          }
          length = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (length === 127) {
          if (buffer.length < offset + 8) {
            return;
          }
          const longLength = buffer.readBigUInt64BE(offset);
          if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('WebSocket payload too large');
          }
          length = Number(longLength);
          offset += 8;
        }

        if (!isMasked) {
          throw new Error('Client WebSocket frames must be masked');
        }

        if (length > maxPayloadBytes) {
          throw new Error('WebSocket payload too large');
        }

        if (buffer.length < offset + 4 + length) {
          return;
        }

        const mask = buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        buffer = buffer.subarray(offset + length);

        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }

        if (opcode === 0x8) {
          onClose?.();
          socket.end();
          return;
        }

        if (opcode === 0x9) {
          writePong(socket, payload);
          continue;
        }

        if (opcode === 0x1 && isFinal) {
          onText(payload.toString('utf8'));
          continue;
        }

        if (opcode === 0x1) {
          fragments = [payload];
          continue;
        }

        if (opcode === 0x0) {
          fragments.push(payload);
          if (isFinal) {
            onText(Buffer.concat(fragments).toString('utf8'));
            fragments = [];
          }
        }
      }
    } catch (error) {
      onError?.(error);
      socket.destroy();
    }
  };
};

export const acceptWebSocket = (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const upgrade = req.headers.upgrade || '';

  if (!key || upgrade.toLowerCase() !== 'websocket') {
    socket.destroy();
    return false;
  }

  const accept = crypto
    .createHash('sha1')
    .update(`${key}${webSocketGuid}`)
    .digest('base64');

  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  return true;
};
