import type { Db } from '../db/kysely.js';
import type { Salon } from '../core/types.js';
import type { GhlClient } from './client.js';
import { MockGhlClient } from './mock.js';
import { RealGhlClient } from './real.js';

export type GhlFactory = (salon: Salon) => GhlClient;

export function makeGhlFactory(opts: { useMock: boolean; db: Db }): GhlFactory {
  if (opts.useMock) {
    const mock = new MockGhlClient(opts.db);
    return () => mock;
  }
  const cache = new Map<string, RealGhlClient>();
  return (salon) => {
    let client = cache.get(salon.id);
    if (!client) {
      client = new RealGhlClient(salon.ghlPit, salon.ghlLocationId);
      cache.set(salon.id, client);
    }
    return client;
  };
}
