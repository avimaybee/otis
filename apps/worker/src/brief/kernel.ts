/**
 * @otis/worker/brief/kernel
 * Production brief kernel wiring injecting @otis/brief into the worker brief service.
 */

import {
  buildBriefDedupeKey,
  evaluateBriefSchedule,
  getLocalDate,
  isValidTimezone,
  orderSelectionsForSave,
  renderBriefText,
  selectBriefItems,
  type BriefScheduleInput,
  type SelectBriefInput,
} from '@otis/brief';
import type { BriefKernel } from './types.js';

export const productionBriefKernel: BriefKernel = {
  evaluateSchedule: (schedule, nowIso, lastGenerated) =>
    evaluateBriefSchedule(schedule as BriefScheduleInput, nowIso, lastGenerated),
  selectItems: (input) => selectBriefItems(input as SelectBriefInput),
  dedupeKey: (workspaceId, userId, localDate) => buildBriefDedupeKey(workspaceId, userId, localDate),
  orderForSave: (items) => orderSelectionsForSave(items),
  renderText: (items) => renderBriefText(items),
  localDate: (nowIso, timezone) => getLocalDate(nowIso, timezone),
  isValidTimezone: (timezone) => isValidTimezone(timezone),
};
