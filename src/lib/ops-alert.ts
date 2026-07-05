import { logger } from './logger.js';

export interface OpsAlert {
  severity: 'warning' | 'critical';
  type: string;
  salonName: string;
  salonId: string;
  detail: string;
}

/**
 * Deliver an operational alert to the humans running the platform.
 *
 * Always emits a structured log line (Render log alerts can key on
 * `ops_alert`). Additionally POSTs to `webhookUrl` when configured — the JSON
 * body carries both `text` (Slack incoming webhook) and `content` (Discord
 * webhook) so either works without transformation.
 *
 * Never throws: alerting is a side channel and must not take down the worker
 * that noticed the problem.
 */
export async function sendOpsAlert(webhookUrl: string | undefined, alert: OpsAlert): Promise<void> {
  const line = `[${alert.severity.toUpperCase()}] ${alert.salonName}: ${alert.type} — ${alert.detail}`;
  logger.warn({ ops_alert: true, ...alert }, line);

  if (!webhookUrl) return;
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: line, content: line }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error({ status: res.status, alertType: alert.type }, 'ops alert webhook returned non-2xx');
    }
  } catch (err) {
    logger.error({ err, alertType: alert.type }, 'ops alert webhook delivery failed');
  }
}
