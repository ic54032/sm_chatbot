import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

export interface RespondJobData {
  conversationId: string;
  salonId: string;
}

export function createConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, { maxRetriesPerRequest: null });
}

export function redisConnectionOptions(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
  };
}

export function createRespondQueue(connection: ConnectionOptions): Queue<RespondJobData> {
  return new Queue<RespondJobData>('respond', { connection });
}
