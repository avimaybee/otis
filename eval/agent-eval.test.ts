/**
 * @otis/eval/agent-eval.test
 * Automated offline fixture evaluation test suite (pure policy/schema rule evaluation).
 * In accordance with docs/archive/plans/006-implementation-handoff.md Section 11 & 12.
 * NOTE: For composed end-to-end pipeline execution with D1 database state, see `apps/worker/test/agent-composed-eval.integration.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAgentEvaluations } from './runner.js';

describe('Gate 006 Agent Fixture Evaluations (Appendix A Pure Policy/Schema Rules)', () => {
  it('executes all offline fixtures, satisfies quality targets, and outputs sanitized report', async () => {
    const report = await runAgentEvaluations();

    // Print evaluation summary table to console
    console.log('\n======================================================');
    console.log('    GATE 006 AGENT OFFLINE POLICY RULE EVALUATION    ');
    console.log('======================================================');
    console.log(`Timestamp:                  ${report.timestamp}`);
    console.log(`Total Fixtures:             ${report.totalFixtures}`);
    console.log(`Passed Fixtures:            ${report.passedFixtures} / ${report.totalFixtures} (${Math.round((report.passedFixtures / report.totalFixtures) * 100)}%)`);
    console.log('------------------------------------------------------');
    console.log(`Wrong Writes:               ${report.metrics.wrong_writes} (Target: 0)`);
    console.log(`Unauthorized Writes:        ${report.metrics.unauthorized_writes} (Target: 0)`);
    console.log(`Action Accuracy Rate:       ${report.metrics.action_accuracy_rate}%`);
    console.log(`Clarification Rate:         ${report.metrics.correct_clarification_rate}%`);
    console.log(`False Abstention Rate:      ${report.metrics.false_abstention_rate}%`);
    console.log(`Source-Link Correctness:    ${report.metrics.source_link_correctness}%`);
    console.log(`Memory Promotion Accuracy:  ${report.metrics.memory_promotion_accuracy !== null ? report.metrics.memory_promotion_accuracy + '%' : 'unmeasured (offline)'}`);
    console.log(`Entity Matching Accuracy:   ${report.metrics.entity_match_accuracy}% (Target: >=95%)`);
    console.log('======================================================\n');

    // Detailed per-fixture results table
    for (const r of report.results) {
      const statusIcon = r.passed ? '✓ PASS' : '✗ FAIL';
      const ref = r.appendixRef ? `[${r.appendixRef}]` : '[-]';
      console.log(`  ${statusIcon} ${ref.padEnd(5)} ${r.fixtureId.padEnd(30)} writes: ${r.appliedWritesCount}, clarifs: ${r.clarificationsCount}`);
      if (r.errorMessages.length > 0) {
        for (const err of r.errorMessages) {
          console.log(`         ERROR: ${err}`);
        }
      }
    }
    console.log('\n');

    // 1. Core safety & correctness invariants
    expect(report.metrics.wrong_writes).toBe(0);
    expect(report.metrics.unauthorized_writes).toBe(0);
    expect(report.metrics.false_abstention_rate).toBe(0);

    // 2. High-precision targets
    expect(report.metrics.action_accuracy_rate).toBeGreaterThanOrEqual(95.0);
    expect(report.metrics.entity_match_accuracy).toBeGreaterThanOrEqual(95.0);
    expect(report.metrics.correct_clarification_rate).toBeGreaterThanOrEqual(95.0);
    expect(report.metrics.source_link_correctness).toBe(100.0);
    expect(report.metrics.memory_promotion_accuracy).toBeNull();

    // 3. All fixtures must pass
    expect(report.passedFixtures).toBe(report.totalFixtures);

    // 4. Verify report artifact written to eval-output/
    const reportPath = path.resolve(process.cwd(), 'eval-output', 'agent-eval-report.json');
    expect(fs.existsSync(reportPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    expect(saved.totalFixtures).toBe(report.totalFixtures);
    expect(saved.metrics.wrong_writes).toBe(0);
  });
});
