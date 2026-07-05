import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Db } from '../db/kysely.js';
import * as salonsRepo from '../db/repos/salons.js';
import * as messagesRepo from '../db/repos/messages.js';
import { sendOpsAlert, type OpsAlert } from '../lib/ops-alert.js';
import { logger } from '../lib/logger.js';

const HEALTH_CHECK_QUEUE = 'health-check';
// Daily at 07:00 UTC — early morning US, mid-morning EU: alerts land before
// the salon's business day starts on either side.
const HEALTH_CHECK_CRON = '0 7 * * *';

const DAY_MS = 24 * 60 * 60 * 1000;
const BASELINE_DAYS = 14;

export interface SalonHealthSnapshot {
  salonId: string;
  salonName: string;
  isActive: boolean;
  inboundLast24h: number;
  /** Average inbound per day over the 14 days preceding the last-24h window. */
  dailyAvgPrior: number;
}

/**
 * Pure decision logic — one snapshot in, zero or more alerts out.
 *
 * - salon_disabled: the salon is switched off (usually the automatic 401/403
 *   PIT kill switch). The bot is answering nobody; a human must reconnect.
 * - inbound_flatline_24h: an account that normally receives >= minDailyAvg
 *   messages per day got NOTHING in 24h. The most likely cause is upstream
 *   breakage (GHL workflow off, IG disconnected) that produces no errors on
 *   our side — silence is the only symptom.
 */
export function evaluateSalonHealth(s: SalonHealthSnapshot, minDailyAvg: number): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  if (!s.isActive) {
    alerts.push({
      severity: 'critical',
      type: 'salon_disabled',
      salonId: s.salonId,
      salonName: s.salonName,
      detail: 'salon is_active=false (likely auto-disabled by a GHL 401/403). Bot is DOWN for this account. See docs/runbook-reconnect.md',
    });
    return alerts; // inbound stats are meaningless while disabled
  }
  if (s.inboundLast24h === 0 && s.dailyAvgPrior >= minDailyAvg) {
    alerts.push({
      severity: 'warning',
      type: 'inbound_flatline_24h',
      salonId: s.salonId,
      salonName: s.salonName,
      detail: `no inbound in 24h; prior ${BASELINE_DAYS}d average is ${s.dailyAvgPrior.toFixed(1)}/day. Check GHL workflow + IG connection. See docs/runbook-reconnect.md`,
    });
  }
  return alerts;
}

export async function runHealthCheck(deps: {
  db: Db;
  opsAlertWebhookUrl?: string;
  minDailyAvg: number;
}): Promise<{ salonsChecked: number; alertsSent: number }> {
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const baselineStart = new Date(dayAgo.getTime() - BASELINE_DAYS * DAY_MS);

  const salons = await salonsRepo.listAllForHealthCheck(deps.db);
  let alertsSent = 0;

  for (const salon of salons) {
    try {
      const [inboundLast24h, baselineCount] = await Promise.all([
        messagesRepo.countInboundForSalon(deps.db, salon.id, dayAgo, now),
        messagesRepo.countInboundForSalon(deps.db, salon.id, baselineStart, dayAgo),
      ]);
      const snapshot: SalonHealthSnapshot = {
        salonId: salon.id,
        salonName: salon.displayName,
        isActive: salon.isActive,
        inboundLast24h,
        dailyAvgPrior: baselineCount / BASELINE_DAYS,
      };
      const alerts = evaluateSalonHealth(snapshot, deps.minDailyAvg);
      for (const alert of alerts) {
        await sendOpsAlert(deps.opsAlertWebhookUrl, alert);
        alertsSent++;
      }
      logger.info(
        { ...snapshot, alerts: alerts.map((a) => a.type) },
        'health check evaluated salon',
      );
    } catch (err) {
      logger.error({ err, salonId: salon.id }, 'health check failed for salon');
    }
  }

  return { salonsChecked: salons.length, alertsSent };
}

export interface HealthCheckSetup {
  queue: Queue;
  worker: Worker;
}

export async function setupHealthCheck(deps: {
  db: Db;
  connection: ConnectionOptions;
  opsAlertWebhookUrl?: string;
  minDailyAvg: number;
}): Promise<HealthCheckSetup> {
  const queue = new Queue(HEALTH_CHECK_QUEUE, { connection: deps.connection });

  // Same idempotency semantics as auto-resume: re-adding with identical repeat
  // options is a no-op; changing the cron requires cleaning the old scheduler.
  await queue.add(
    'health-check-tick',
    {},
    {
      repeat: { pattern: HEALTH_CHECK_CRON },
      removeOnComplete: true,
      removeOnFail: 10,
    },
  );

  const worker = new Worker(
    HEALTH_CHECK_QUEUE,
    async () => {
      const result = await runHealthCheck(deps);
      logger.info(result, 'health check tick complete');
    },
    { connection: deps.connection, concurrency: 1 },
  );

  return { queue, worker };
}
