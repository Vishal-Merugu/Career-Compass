import { Server, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { ClientEvents } from './events.js';
import { ConnectionRegistry } from './connectionRegistry.js';
import { socketAuthMiddleware } from './middleware/auth.js';
import { wrapSocketHandler } from './middleware/errorBoundary.js';

// Inbound handlers
import { onRegister } from './handlers/onRegister.js';
import { onUrlBatchItem } from './handlers/onUrlBatchItem.js';
import { onUrlBatchComplete } from './handlers/onUrlBatchComplete.js';
import { onProfileScraped } from './handlers/onProfileScraped.js';
import { onProfileScrapeFailed } from './handlers/onProfileScrapeFailed.js';
import { onHeartbeat } from './handlers/onHeartbeat.js';
import { onSessionValid } from './handlers/onSessionValid.js';
import { onSessionInvalid } from './handlers/onSessionInvalid.js';
import { onEmailFound } from './handlers/onEmailFound.js';
import { onEmailFindFailed } from './handlers/onEmailFindFailed.js';
let ioInstance: Server | null = null;

export function setIo(io: Server) {
  ioInstance = io;
}

export function getIo(): Server {
  if (!ioInstance) {
    throw new Error('Socket.io server not initialized');
  }
  return ioInstance;
}

/**
 * Bootstraps the WebSocket gateway.
 */
export function initWsGateway(httpServer: HttpServer): Server {
  logger.info('[WsGateway] Initializing Socket.io server...');

  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['*'];

  const io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (
          !origin ||
          allowedOrigins.includes('*') ||
          allowedOrigins.includes(origin) ||
          origin.startsWith('chrome-extension://')
        ) {
          callback(null, true);
        } else {
          callback(new Error('Not allowed by CORS'));
        }
      },
      methods: ['GET', 'POST'],
    },
    pingInterval: 10000,
    pingTimeout: 5000,
  });

  setIo(io);

  // Apply authentication middleware
  io.use(socketAuthMiddleware);

  io.on('connection', (socket: Socket) => {
    const { jobId, userId } = socket.data;
    logger.info(
      `[WsGateway] Socket connected: ${socket.id} for Job: ${jobId}, User: ${userId}`,
    );

    // Register inbound event handlers wrapped in the error boundary
    socket.on(
      ClientEvents.REGISTER,
      wrapSocketHandler(socket, (payload) => onRegister(socket, payload)),
    );
    socket.on(
      ClientEvents.URL_BATCH_ITEM,
      wrapSocketHandler(socket, (payload) => onUrlBatchItem(socket, payload)),
    );
    socket.on(
      ClientEvents.URL_BATCH_COMPLETE,
      wrapSocketHandler(socket, (payload) =>
        onUrlBatchComplete(socket, payload),
      ),
    );
    socket.on(
      ClientEvents.PROFILE_SCRAPED,
      wrapSocketHandler(socket, (payload) => onProfileScraped(socket, payload)),
    );
    socket.on(
      ClientEvents.PROFILE_SCRAPE_FAILED,
      wrapSocketHandler(socket, (payload) =>
        onProfileScrapeFailed(socket, payload),
      ),
    );
    socket.on(
      ClientEvents.SESSION_VALID,
      wrapSocketHandler(socket, () => onSessionValid(socket)),
    );
    socket.on(
      ClientEvents.SESSION_INVALID,
      wrapSocketHandler(socket, () => onSessionInvalid(socket)),
    );
    socket.on(
      ClientEvents.HEARTBEAT,
      wrapSocketHandler(socket, () => onHeartbeat(socket)),
    );
    socket.on(
      ClientEvents.EMAIL_FOUND,
      wrapSocketHandler(socket, (payload) => onEmailFound(socket, payload)),
    );
    socket.on(
      ClientEvents.EMAIL_FIND_FAILED,
      wrapSocketHandler(socket, (payload) =>
        onEmailFindFailed(socket, payload),
      ),
    );

    // Handle Socket Disconnect
    socket.on('disconnect', async (reason) => {
      logger.info(
        `[WsGateway] Socket disconnected: ${socket.id} (Reason: ${reason})`,
      );

      // Remove from in-memory registry
      ConnectionRegistry.getInstance().deregister(socket.id);

      // Record disconnect in database
      try {
        await prisma.extensionConnection.updateMany({
          where: {
            socketId: socket.id,
            disconnectedAt: null,
          },
          data: {
            disconnectedAt: new Date(),
          },
        });
      } catch (err) {
        logger.error(
          err,
          `[WsGateway] Failed to update disconnectedAt in DB for socket: ${socket.id}`,
        );
      }
    });
  });

  // Start connection heartbeat sweeper (runs every 15 seconds)
  setInterval(() => {
    try {
      const registry = ConnectionRegistry.getInstance();
      const stale = registry.getStaleConnections(45000); // 45 seconds stale limit

      for (const entry of stale) {
        logger.warn(
          `[WsGateway] Connection stale (no heartbeat for 45s). Kicking socket ${entry.socketId} for Job ${entry.jobId}`,
        );

        const socketInstance = io.sockets.sockets.get(entry.socketId);
        if (socketInstance) {
          socketInstance.emit('ERROR', {
            message: 'Connection timed out due to heartbeat inactivity.',
            code: 'HEARTBEAT_TIMEOUT',
          });
          socketInstance.disconnect(true);
        } else {
          // If socket not found in socket.io server pool, just deregister manually
          registry.deregister(entry.socketId);
        }
      }
    } catch (err) {
      logger.error(
        err,
        '[WsGateway] Error in stale connections heartbeat sweeper',
      );
    }
  }, 15000);

  return io;
}
