import { describe, it, expect } from 'vitest';
import { SotSchema } from '../../../src/core/sot-schema.js';

const validSot = {
  salon_basics: {
    owner_first_name: 'Renata',
    salon_name: 'Lumen Hair Studio',
    address: '1847 Pearl Street',
    instagram_handle: '@lumenhairstudio',
  },
  booking: {
    url: 'https://lumenhairstudio.glossgenius.com/book',
    platform: 'GlossGenius',
  },
  price_quoting_policy: 'b',
  service_menu: { color: 'balayage and more' },
  pricing: [{ service_name: 'Full Balayage', price: '$220-$320' }],
  faq: [{ question: 'Do you take walk-ins?', answer: 'By appointment.' }],
};

describe('SotSchema', () => {
  it('accepts a valid new-structure SOT', () => {
    const parsed = SotSchema.parse(validSot);
    expect(parsed.salon_basics.owner_first_name).toBe('Renata');
    expect(parsed.booking.url).toBe('https://lumenhairstudio.glossgenius.com/book');
    expect(parsed.price_quoting_policy).toBe('b');
  });

  it('preserves passthrough fields (service_menu, pricing, faq)', () => {
    const parsed = SotSchema.parse(validSot) as Record<string, unknown>;
    expect(parsed.service_menu).toBeDefined();
    expect(parsed.pricing).toBeDefined();
    expect(parsed.faq).toBeDefined();
  });

  it('preserves passthrough fields inside salon_basics and booking', () => {
    const parsed = SotSchema.parse(validSot);
    const basics = parsed.salon_basics as Record<string, unknown>;
    const booking = parsed.booking as Record<string, unknown>;
    expect(basics.instagram_handle).toBe('@lumenhairstudio');
    expect(booking.platform).toBe('GlossGenius');
  });

  it('rejects missing owner_first_name', () => {
    const bad = { ...validSot, salon_basics: { salon_name: 'X' } };
    expect(() => SotSchema.parse(bad)).toThrow();
  });

  it('rejects invalid booking url', () => {
    const bad = { ...validSot, booking: { url: 'not-a-url' } };
    expect(() => SotSchema.parse(bad)).toThrow();
  });

  it('rejects invalid price_quoting_policy', () => {
    const bad = { ...validSot, price_quoting_policy: 'x' };
    expect(() => SotSchema.parse(bad)).toThrow();
  });

  it('accepts service_menu.not_offered as string array and preserves it', () => {
    const sot = { ...validSot, service_menu: { color: 'balayage', not_offered: ['nails', 'perms'] } };
    const parsed = SotSchema.parse(sot);
    expect(parsed.service_menu?.not_offered).toEqual(['nails', 'perms']);
    expect((parsed.service_menu as Record<string, unknown>).color).toBe('balayage');
  });

  it('defaults not_offered to empty array when service_menu is present without it', () => {
    const parsed = SotSchema.parse(validSot);
    expect(parsed.service_menu?.not_offered).toEqual([]);
  });

  it('still validates when service_menu is entirely absent (legacy rows)', () => {
    const { service_menu: _omit, ...noMenu } = validSot;
    const parsed = SotSchema.parse(noMenu);
    expect(parsed.service_menu).toBeUndefined();
  });

  it('rejects non-string entries in not_offered', () => {
    const bad = { ...validSot, service_menu: { not_offered: [42] } };
    expect(() => SotSchema.parse(bad)).toThrow();
  });
});
