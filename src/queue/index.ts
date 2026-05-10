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
  const isTls = url.protocol === 'rediss:';
  const db = url.pathname && url.pathname !== '/'
    ? Number(url.pathname.replace(/^\//, ''))
    : 0;

  const options: ConnectionOptions = {
    host: url.hostname,
    port: Number(url.port || (isTls ? 6380 : 6379)),
    db,
  };
  if (url.username) (options as { username?: string }).username = decodeURIComponent(url.username);
  if (url.password) (options as { password?: string }).password = decodeURIComponent(url.password);
  if (isTls) (options as { tls?: object }).tls = {};
  return options;
}

export function createRespondQueue(connection: ConnectionOptions): Queue<RespondJobData> {
  return new Queue<RespondJobData>('respond', { connection });
}
