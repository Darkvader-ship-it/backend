import { config } from '@/config/config';
import { UserModel } from '@/models/user.model';
import { summarize, type Summary } from '@/services/analytics.service';
import { queueEmail } from '@/services/email.service';
import { logger } from '@/utils/logger';

/** Formats a cent amount as a dollar string, e.g. 10050 → "$100.50". */
function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function buildReport(summary: Summary, storeName: string): { subject: string; text: string } {
  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });

  const methodLines = summary.byMethod
    .map((m) => `  ${m.method.padEnd(16)} ${String(m.count).padStart(4)} sales   ${fmt(m.amountCents)}`)
    .join('\n');

  const text = [
    `${storeName} — Daily Settlement Report`,
    `${date}`,
    '',
    '── Sales ───────────────────────────────',
    `  Transactions      ${summary.totalSales}`,
    `  Gross revenue     ${fmt(summary.totalRevenueCents)}`,
    `  Tax collected     ${fmt(summary.taxCents)}`,
    `  Discounts given   ${fmt(summary.discountCents)}`,
    `  Average ticket    ${fmt(summary.averageTicketCents)}`,
    `  Units sold        ${summary.unitsSold}`,
    '',
    '── Payment methods ─────────────────────',
    methodLines || '  (no completed payments)',
    '',
    '── Other ───────────────────────────────',
    `  Refunds           ${summary.refunds}`,
    `  Voids             ${summary.voids}`,
    `  Low-stock items   ${summary.lowStockProducts}`,
    `  Total customers   ${summary.customers}`,
    '',
    'This report was generated automatically by StellarPOS.',
  ].join('\n');

  return { subject: `Settlement report — ${date}`, text };
}

/**
 * Generates yesterday's settlement summary and queues a report email to every
 * admin and manager. Called once per day by the scheduler below.
 */
export function sendDailySettlementReport(): void {
  try {
    const summary = summarize(1);
    const { subject, text } = buildReport(summary, config.store.name);
    const recipients = UserModel.list().filter((u) => u.role === 'admin' || u.role === 'manager');
    if (!recipients.length) {
      logger.warn('Settlement report: no admin/manager recipients found');
      return;
    }
    for (const user of recipients) {
      queueEmail({ to: user.email, subject, text });
    }
    logger.info(
      `Settlement report queued for ${recipients.length} recipient(s) (${summary.totalSales} transactions, ${fmt(summary.totalRevenueCents)} revenue)`,
    );
  } catch (err) {
    logger.error(`Settlement report failed: ${(err as Error).message}`);
  }
}

let timer: NodeJS.Timeout | null = null;

/**
 * Schedules the daily settlement report to fire every 24 hours.
 * Set SETTLEMENT_REPORT_HOUR (0–23 UTC, default 0) to control the
 * wall-clock hour of the first send; subsequent sends are exactly 24 h later.
 *
 * Set SETTLEMENT_REPORT_ENABLED=false to disable without removing the import.
 */
export function startSettlementSchedule(): void {
  const enabled =
    process.env.SETTLEMENT_REPORT_ENABLED !== 'false' && config.env !== 'test';
  if (!enabled) return;

  const targetHour = Math.min(23, Math.max(0, Number(process.env.SETTLEMENT_REPORT_HOUR ?? 0)));
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetHour, 0, 0, 0),
  );
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delayMs = next.getTime() - now.getTime();

  setTimeout(() => {
    sendDailySettlementReport();
    timer = setInterval(sendDailySettlementReport, 24 * 60 * 60 * 1000);
    timer.unref();
  }, delayMs).unref();

  logger.info(
    `Daily settlement reports scheduled at ${String(targetHour).padStart(2, '0')}:00 UTC (first in ${Math.round(delayMs / 60_000)} min)`,
  );
}

export function stopSettlementSchedule(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
