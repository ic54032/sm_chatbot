import { describe, it, expect } from 'vitest';
import { makeGhlFactory } from '../../../src/ghl/factory.js';
import { MockGhlClient } from '../../../src/ghl/mock.js';
import { RealGhlClient } from '../../../src/ghl/real.js';
import type { Salon } from '../../../src/core/types.js';

const mockDb = {} as never; // MockGhlClient constructor accepts unused-typed db in tests

function makeSalon(id: string, pit = 'pit', locationId = 'loc-1'): Salon {
  return {
    id,
    displayName: 'Test',
    ghlLocationId: locationId,
    ghlPit: pit,
    isActive: true,
    sourceOfTruth: { salon: { booking_link: 'https://x/book' } } as Salon['sourceOfTruth'],
    config: {} as Salon['config'],
  };
}

describe('makeGhlFactory', () => {
  it('mock mode returns same MockGhlClient instance for different salons', () => {
    const { factory } = makeGhlFactory({ useMock: true, db: mockDb });
    const client1 = factory(makeSalon('s1'));
    const client2 = factory(makeSalon('s2'));
    expect(client1).toBe(client2);
    expect(client1).toBeInstanceOf(MockGhlClient);
  });

  it('real mode returns RealGhlClient cached per salon.id', () => {
    const { factory } = makeGhlFactory({ useMock: false, db: mockDb });
    const salonA = makeSalon('sA', 'pit-A', 'loc-A');
    const client1 = factory(salonA);
    const client2 = factory(salonA);
    expect(client1).toBe(client2);
    expect(client1).toBeInstanceOf(RealGhlClient);

    const salonB = makeSalon('sB', 'pit-B', 'loc-B');
    const client3 = factory(salonB);
    expect(client3).not.toBe(client1);
    expect(client3).toBeInstanceOf(RealGhlClient);
  });

  it('mock mode exposes the same MockGhlClient instance as mockInstance', () => {
    const setup = makeGhlFactory({ useMock: true, db: mockDb });
    expect(setup.mockInstance).toBeInstanceOf(MockGhlClient);
    expect(setup.factory(makeSalon('s1'))).toBe(setup.mockInstance);
  });

  it('real mode has mockInstance undefined', () => {
    const setup = makeGhlFactory({ useMock: false, db: mockDb });
    expect(setup.mockInstance).toBeUndefined();
  });
});
