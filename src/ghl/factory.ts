import type { Db } from '../db/kysely.js';
import type { Salon } from '../core/types.js';
import type { GhlClient } from './client.js';
import { MockGhlClient } from './mock.js';
import { RealGhlClient } from './real.js';

export type GhlFactory = (salon: Salon) => GhlClient;

export interface GhlFactorySetup {
  factory: GhlFactory;
  mockInstance: MockGhlClient | undefined;
}

export function makeGhlFactory(opts: { useMock: boolean; db: Db }): GhlFactorySetup {
  if (opts.useMock) {
    const mock = new MockGhlClient(opts.db);
    return { factory: () => mock, mockInstance: mock };
  }
  const cache = new Map<string, RealGhlClient>();
  return {
    factory: (salon) => {
      let client = cache.get(salon.id);
      if (!client) {
        client = new RealGhlClient(salon.ghlPit, salon.ghlLocationId);
        cache.set(salon.id, client);
      }
      return client;
    },
    mockInstance: undefined,
  };
}
