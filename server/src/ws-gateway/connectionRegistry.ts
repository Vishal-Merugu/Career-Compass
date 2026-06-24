import { logger } from '../lib/logger.js';

interface ConnectionEntry {
  jobId: string;
  userId: string;
  socketId: string;
  connectedAt: Date;
  lastHeartbeatAt: Date;
}

export class ConnectionRegistry {
  private static instance: ConnectionRegistry | null = null;

  // Maps jobId -> ConnectionEntry
  private jobConnections: Map<string, ConnectionEntry> = new Map();
  // Maps socketId -> jobId
  private socketToJob: Map<string, string> = new Map();

  private constructor() {}

  public static getInstance(): ConnectionRegistry {
    if (!ConnectionRegistry.instance) {
      ConnectionRegistry.instance = new ConnectionRegistry();
    }
    return ConnectionRegistry.instance;
  }

  /**
   * Register a new connection for a job.
   * If a previous connection exists for the same jobId, it returns the old socket ID
   * so it can be disconnected (kicked).
   */
  public register(
    jobId: string,
    userId: string,
    socketId: string,
  ): string | null {
    const existing = this.jobConnections.get(jobId);
    let kickedSocketId: string | null = null;

    if (existing) {
      if (existing.socketId !== socketId) {
        logger.info(
          `[ConnectionRegistry] Job ${jobId} registered on new socket ${socketId}. Kicking old socket ${existing.socketId}`,
        );
        kickedSocketId = existing.socketId;
        this.socketToJob.delete(existing.socketId);
      }
    }

    const entry: ConnectionEntry = {
      jobId,
      userId,
      socketId,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
    };

    this.jobConnections.set(jobId, entry);
    this.socketToJob.set(socketId, jobId);

    return kickedSocketId;
  }

  /**
   * Deregister connection by socketId.
   */
  public deregister(socketId: string): ConnectionEntry | null {
    const jobId = this.socketToJob.get(socketId);
    if (!jobId) return null;

    this.socketToJob.delete(socketId);
    const entry = this.jobConnections.get(jobId);

    if (entry && entry.socketId === socketId) {
      this.jobConnections.delete(jobId);
      return entry;
    }

    return null;
  }

  /**
   * Update heartbeat timestamp for a socket.
   */
  public heartbeat(socketId: string): boolean {
    const jobId = this.socketToJob.get(socketId);
    if (!jobId) return false;

    const entry = this.jobConnections.get(jobId);
    if (entry && entry.socketId === socketId) {
      entry.lastHeartbeatAt = new Date();
      return true;
    }
    return false;
  }

  /**
   * Get active socketId for a jobId.
   */
  public getSocketId(jobId: string): string | null {
    const entry = this.jobConnections.get(jobId);
    return entry ? entry.socketId : null;
  }

  /**
   * Get connection entry by socketId.
   */
  public getConnectionBySocket(socketId: string): ConnectionEntry | null {
    const jobId = this.socketToJob.get(socketId);
    if (!jobId) return null;
    return this.jobConnections.get(jobId) || null;
  }

  /**
   * Retrieve all stale connections (no heartbeat in the last 45 seconds).
   */
  public getStaleConnections(timeoutMs = 45000): ConnectionEntry[] {
    const now = Date.now();
    const stale: ConnectionEntry[] = [];

    for (const entry of this.jobConnections.values()) {
      if (now - entry.lastHeartbeatAt.getTime() > timeoutMs) {
        stale.push(entry);
      }
    }

    return stale;
  }
}
