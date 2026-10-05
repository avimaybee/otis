/**
 * @otis/worker/brief
 *
 * 011B brief delivery service: scheduled canonical daily briefs and the
 * on-demand today builder. No transport here; the coordinator owns cron
 * and command-route linking.
 */

export * from './types.js';
export * from './service.js';
export * from './kernel.js';
export * from './cron.js';
