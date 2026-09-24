import type { Change, Mismatch, RunReport, TrialResult } from '../types.js';

export const pct = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 100)}%`);
export const usd = (x: number | null): string => (x === null ? 'n/a' : `$${x.toFixed(4)}`);

export function changeCounts(changes: Change[]): { breaking: number; risky: number; safe: number } {
  return {
    breaking: changes.filter((c) => c.severity === 'breaking').length,
    risky: changes.filter((c) => c.severity === 'risky').length,
    safe: changes.filter((c) => c.severity === 'safe').length,
  };
}

/** One-line status per section, shared by every renderer. */
export function sectionStatus(r: RunReport): { name: string; passed: boolean; summary: string }[] {
  const out: { name: string; passed: boolean; summary: string }[] = [];
  if (r.contract) {
    const c = changeCounts(r.contract.changes);
    const state = r.contract.created ? 'snapshot created' : r.contract.updated ? 'snapshot updated' : `${c.breaking} breaking, ${c.risky} risky, ${c.safe} safe`;
    out.push({ name: 'Contract', passed: r.contract.passed, summary: `${state}; ${r.contract.lint.length} lint issue(s)` });
  }
  if (r.replay) {
    const pass = r.replay.cases.filter((x) => x.status === 'pass').length;
    out.push({ name: 'Replay', passed: r.replay.passed, summary: `${pass}/${r.replay.cases.length} cassettes match` });
  }
  if (r.eval) {
    const t = r.eval.totals;
    const passed = r.eval.scenarios.filter((s) => s.passed).length;
    out.push({ name: 'Evals', passed: r.eval.passed, summary: `${passed}/${r.eval.scenarios.length} scenarios pass (${t.passedTrials}/${t.trials} trials), ${usd(t.costUsd)}` });
  }
  return out;
}

export function formatMismatch(m: Mismatch): string {
  const show = (v: unknown): string => (v === undefined ? '(none)' : JSON.stringify(v));
  switch (m.reason) {
    case 'missing': return `${m.path}: missing (expected ${show(m.expected)})`;
    case 'extra': return `${m.path}: unexpected field ${show(m.actual)}`;
    case 'length': return `${m.path}: length ${show(m.expected)} -> ${show(m.actual)}`;
    case 'regex': return `${m.path}: ${show(m.actual)} does not match /${String(m.expected)}/`;
    default: return `${m.path}: expected ${show(m.expected)}, got ${show(m.actual)}`;
  }
}

/**
 * One-line failure summary for a single eval trial: its error (if any) followed by each
 * failed check's description (with detail in parens). Shared by terminal.ts and junit.ts
 * so both renderers describe a failed trial identically.
 */
export function formatTrialFailure(t: TrialResult): string {
  const failed = t.checks.filter((c) => !c.passed).map((c) => c.description + (c.detail ? ` (${c.detail})` : ''));
  return [t.error, ...failed].filter(Boolean).join('; ');
}
