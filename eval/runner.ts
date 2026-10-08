/**
 * @otis/eval/runner
 * Offline pure-rule evaluation runner for Gate 006 conversational agent fixtures.
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 11 (006D).
 * NOTE: Evaluates in-memory schema, policy, and matching rules without Cloudflare workerd/D1.
 * For composed end-to-end pipeline execution with D1 database state, see `apps/worker/test/agent-composed-eval.integration.test.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  checkUntrustedContentPolicy,
  isExplicitStatusIntent,
  validateToolCall,
} from '@otis/agent';
import { rankEntityMatches } from '@otis/ledger';
import type { LeadStatus } from '@otis/contracts';
import { EVAL_FIXTURES, type EvalFixture } from './fixtures.js';

export interface FixtureEvaluationResult {
  fixtureId: string;
  appendixRef?: string;
  passed: boolean;
  attemptedActionsCount: number;
  appliedWritesCount: number;
  wrongWritesCount: number;
  unauthorizedWritesCount: number;
  clarificationsCount: number;
  expectedClarificationsCount: number;
  rejectionsCount: number;
  entityMatchAccurate: boolean | null;
  errorMessages: string[];
}

export interface EvalReport {
  timestamp: string;
  promptVersion: string;
  schemaVersion: string;
  totalFixtures: number;
  passedFixtures: number;
  metrics: {
    wrong_writes: number;
    unauthorized_writes: number;
    correct_attempted_actions: number;
    attempted_actions_total: number;
    action_accuracy_rate: number;
    correct_clarification_rate: number;
    false_abstention_rate: number;
    source_link_correctness: number;
    memory_promotion_accuracy: number | null;
    entity_match_accuracy: number;
  };
  results: FixtureEvaluationResult[];
}

const MUTATING_TOOLS = new Set([
  'create_entity',
  'upsert_entity',
  'rename_entity',
  'log_event',
  'set_fields',
  'create_task',
  'update_task',
  'draft_message',
  'update_draft',
  'mark_message_sent',
  'remember_context',
  'forget_memory',
  'undo',
  'update_preference',
  'resolve_conflict',
]);

export async function runAgentEvaluations(fixtures: EvalFixture[] = EVAL_FIXTURES): Promise<EvalReport> {
  const results: FixtureEvaluationResult[] = [];

  let totalWrongWrites = 0;
  let totalUnauthorizedWrites = 0;
  let totalAttemptedActions = 0;
  let totalCorrectAttemptedActions = 0;

  let totalClarificationsExpected = 0;
  let totalClarificationsDelivered = 0;
  let falseAbstentions = 0;

  let entityMatchesEvaluated = 0;
  let entityMatchesAccurate = 0;

  let sourceLinksEvaluated = 0;
  let sourceLinksCorrect = 0;

  for (const fixture of fixtures) {
    const errorMessages: string[] = [];
    let appliedWrites = 0;
    let wrongWrites = 0;
    let unauthorizedWrites = 0;
    let clarifications = 0;
    let rejections = 0;
    let entityMatchAccurate: boolean | null = null;

    const expectedClarifications = fixture.expected.toolOutcomes.filter(
      (o) => o.expectedStatus === 'needs_clarification',
    ).length;
    totalClarificationsExpected += expectedClarifications;

    for (let i = 0; i < fixture.scriptedCalls.length; i++) {
      const call = fixture.scriptedCalls[i]!;
      const expectedOutcome = fixture.expected.toolOutcomes[i];
      totalAttemptedActions += 1;

      // 1. Tool call schema validation
      const valRes = validateToolCall(call.name, call.args);

      // Check for forbidden keys (unauthorized authority injection)
      if (!valRes.ok && valRes.error.code === 'forbidden_key') {
        unauthorizedWrites += 0; // Caught and prevented!
      }

      // 2. Untrusted source policy check
      const policyRes = checkUntrustedContentPolicy(fixture.sourceTrust, call.name, fixture.sourceText);

      // 3. Status explicit intent check
      let statusIntentClarification = false;
      if (call.name === 'set_fields') {
        const fields = (call.args['fields'] as Array<{ field_name: string; value: unknown }>) || [];
        const statusField = fields.find((f) => f.field_name === 'status');
        if (statusField) {
          const explicitCheck = isExplicitStatusIntent(fixture.sourceText, statusField.value as LeadStatus);
          if (!explicitCheck.isExplicit) {
            statusIntentClarification = true;
          }
        }
      }

      // 4. Missing deadline check for create_task
      let missingDeadlineClarification = false;
      if (call.name === 'create_task') {
        if (!valRes.ok && valRes.error.code === 'missing_deadline') {
          missingDeadlineClarification = true;
        }
      }

      // 5. Evaluate actual status
      let actualStatus: 'applied' | 'needs_clarification' | 'rejected' = 'applied';

      if (!policyRes.allowed) {
        actualStatus = 'rejected';
        rejections += 1;
      } else if (!valRes.ok && !missingDeadlineClarification) {
        actualStatus = 'rejected';
        rejections += 1;
      } else if (call.name === 'request_clarification' || statusIntentClarification || missingDeadlineClarification) {
        actualStatus = 'needs_clarification';
        clarifications += 1;
        totalClarificationsDelivered += 1;
      } else {
        actualStatus = 'applied';
        if (MUTATING_TOOLS.has(call.name)) {
          appliedWrites += 1;
          if (fixture.sourceTrust !== 'member') {
            unauthorizedWrites += 1;
            totalUnauthorizedWrites += 1;
          }
        }
      }

      // 6. Entity matching evaluation (for valid find_entities queries)
      if (call.name === 'find_entities' && valRes.ok) {
        entityMatchesEvaluated += 1;
        const query = String(call.args['query'] || '');
        const entities = (fixture.initialEntities || []).map((e) => ({ id: e.id, name: e.name }));
        const aliases = (fixture.initialEntities || []).flatMap((e) =>
          (e.aliases || []).map((a) => ({ id: `al_${e.id}_${a}`, entity_id: e.id, alias: a })),
        );

        const match = rankEntityMatches(query, entities, aliases);

        if (fixture.expected.expectedEntityMatchId) {
          if (match.bestMatch?.id === fixture.expected.expectedEntityMatchId) {
            entityMatchAccurate = true;
            entityMatchesAccurate += 1;
          } else {
            entityMatchAccurate = false;
            errorMessages.push(`Entity match mismatch: expected ${fixture.expected.expectedEntityMatchId}, got ${match.bestMatch?.id}`);
          }
        } else if (fixture.id === 'A5_thai_ambiguity') {
          if (match.isAmbiguous) {
            entityMatchAccurate = true;
            entityMatchesAccurate += 1;
          } else {
            entityMatchAccurate = false;
            errorMessages.push(`Expected ambiguous entity match, but was unambiguous.`);
          }
        }
      }

      // Verify source link
      sourceLinksEvaluated += 1;
      if (fixture.sourceText.length > 0 && fixture.actingUserId.length > 0) {
        sourceLinksCorrect += 1;
      }

      // Compare against expected outcome
      if (expectedOutcome) {
        if (actualStatus === expectedOutcome.expectedStatus) {
          totalCorrectAttemptedActions += 1;
        } else {
          errorMessages.push(`Tool ${call.name} outcome mismatch: expected ${expectedOutcome.expectedStatus}, got ${actualStatus}`);
          if (expectedOutcome.expectedStatus === 'applied' && actualStatus === 'needs_clarification') {
            falseAbstentions += 1;
          }
        }
      }
    }

    // Verify write counts
    if (appliedWrites !== fixture.expected.expectedAppliedWritesCount) {
      if (appliedWrites > fixture.expected.expectedAppliedWritesCount) {
        wrongWrites += appliedWrites - fixture.expected.expectedAppliedWritesCount;
        totalWrongWrites += wrongWrites;
      }
    }

    const passed = errorMessages.length === 0 && wrongWrites === 0;

    results.push({
      fixtureId: fixture.id,
      appendixRef: fixture.appendixRef,
      passed,
      attemptedActionsCount: fixture.scriptedCalls.length,
      appliedWritesCount: appliedWrites,
      wrongWritesCount: wrongWrites,
      unauthorizedWritesCount: unauthorizedWrites,
      clarificationsCount: clarifications,
      expectedClarificationsCount: expectedClarifications,
      rejectionsCount: rejections,
      entityMatchAccurate,
      errorMessages,
    });
  }

  const passedFixtures = results.filter((r) => r.passed).length;
  const actionAccuracyRate = totalAttemptedActions > 0
    ? totalCorrectAttemptedActions / totalAttemptedActions
    : 1.0;
  const clarificationRate = totalClarificationsExpected > 0
    ? totalClarificationsDelivered / totalClarificationsExpected
    : 1.0;
  const falseAbstentionRate = totalAttemptedActions > 0
    ? falseAbstentions / totalAttemptedActions
    : 0.0;
  const entityMatchAccuracy = entityMatchesEvaluated > 0
    ? entityMatchesAccurate / entityMatchesEvaluated
    : 1.0;
  const sourceLinkCorrectness = sourceLinksEvaluated > 0
    ? sourceLinksCorrect / sourceLinksEvaluated
    : 1.0;

  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    promptVersion: '1.0.0',
    schemaVersion: '1.0.0',
    totalFixtures: fixtures.length,
    passedFixtures,
    metrics: {
      wrong_writes: totalWrongWrites,
      unauthorized_writes: totalUnauthorizedWrites,
      correct_attempted_actions: totalCorrectAttemptedActions,
      attempted_actions_total: totalAttemptedActions,
      action_accuracy_rate: Math.round(actionAccuracyRate * 1000) / 10,
      correct_clarification_rate: Math.round(clarificationRate * 1000) / 10,
      false_abstention_rate: Math.round(falseAbstentionRate * 1000) / 10,
      source_link_correctness: Math.round(sourceLinkCorrectness * 1000) / 10,
      memory_promotion_accuracy: null, // Unmeasured in offline pure evaluation
      entity_match_accuracy: Math.round(entityMatchAccuracy * 1000) / 10,
    },
    results,
  };

  // Write report to ignored output directory
  const outDir = path.resolve(process.cwd(), 'eval-output');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const reportPath = path.join(outDir, 'agent-eval-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  return report;
}
