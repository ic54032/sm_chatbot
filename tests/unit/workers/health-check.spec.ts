import { describe, it, expect } from 'vitest';
import { evaluateSalonHealth, type SalonHealthSnapshot } from '../../../src/workers/health-check.js';

const base: SalonHealthSnapshot = {
  salonId: 's1',
  salonName: 'Lumen Hair Studio',
  isActive: true,
  inboundLast24h: 5,
  dailyAvgPrior: 4,
};

const MIN_AVG = 2;

describe('evaluateSalonHealth', () => {
  it('healthy active salon with traffic produces no alerts', () => {
    expect(evaluateSalonHealth(base, MIN_AVG)).toEqual([]);
  });

  it('disabled salon produces a critical salon_disabled alert', () => {
    const alerts = evaluateSalonHealth({ ...base, isActive: false }, MIN_AVG);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('salon_disabled');
    expect(alerts[0].severity).toBe('critical');
  });

  it('disabled salon does not ALSO get a flatline alert (disabled short-circuits)', () => {
    const alerts = evaluateSalonHealth(
      { ...base, isActive: false, inboundLast24h: 0, dailyAvgPrior: 10 },
      MIN_AVG,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('salon_disabled');
  });

  it('active salon with zero inbound in 24h and healthy baseline alerts inbound_flatline_24h', () => {
    const alerts = evaluateSalonHealth({ ...base, inboundLast24h: 0, dailyAvgPrior: 4 }, MIN_AVG);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('inbound_flatline_24h');
    expect(alerts[0].severity).toBe('warning');
    expect(alerts[0].detail).toContain('4.0/day');
  });

  it('quiet-by-nature account (baseline below threshold) does NOT alert on a silent day', () => {
    const alerts = evaluateSalonHealth({ ...base, inboundLast24h: 0, dailyAvgPrior: 0.5 }, MIN_AVG);
    expect(alerts).toEqual([]);
  });

  it('baseline exactly at threshold counts as normally-active (alerts on silence)', () => {
    const alerts = evaluateSalonHealth({ ...base, inboundLast24h: 0, dailyAvgPrior: MIN_AVG }, MIN_AVG);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('inbound_flatline_24h');
  });

  it('a single inbound in 24h suppresses the flatline alert', () => {
    const alerts = evaluateSalonHealth({ ...base, inboundLast24h: 1, dailyAvgPrior: 10 }, MIN_AVG);
    expect(alerts).toEqual([]);
  });

  it('brand new salon (zero baseline, zero traffic) stays quiet', () => {
    const alerts = evaluateSalonHealth({ ...base, inboundLast24h: 0, dailyAvgPrior: 0 }, MIN_AVG);
    expect(alerts).toEqual([]);
  });
});
