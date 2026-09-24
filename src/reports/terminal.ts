import type { RunReport } from '../types.js';
import { formatMismatch, formatTrialFailure, pct, sectionStatus, usd } from './format.js';

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

/** Plain-text report (no ANSI colors, so it reads the same in CI logs). */
export function renderTerminal(r: RunReport): string {
  const lines: string[] = [`mcp-eval-kit ${r.version} - ${r.server}`, ''];
  for (const s of sectionStatus(r)) lines.push(`${s.passed ? 'PASS' : 'FAIL'}  ${s.name}: ${s.summary}`);

  if (r.contract) {
    lines.push('', `Contract (${r.contract.snapshotPath})`);
    if (r.contract.changes.length) lines.push(table([['SEVERITY', 'TARGET', 'CHANGE'], ...r.contract.changes.map((c) => [c.severity.toUpperCase(), c.target, c.message])]));
    else lines.push('  no schema changes');
    if (r.contract.lint.length) {
      lines.push('', 'Lint');
      lines.push(table([['LEVEL', 'RULE', 'TARGET', 'MESSAGE'], ...r.contract.lint.map((i) => [i.level, i.rule, i.target, i.message])]));
    }
  }
  if (r.replay) {
    lines.push('', 'Replay');
    lines.push(table([['STATUS', 'CASE', 'TOOL'], ...r.replay.cases.map((c) => [c.status.toUpperCase(), c.name, c.tool])]));
    for (const c of r.replay.cases) {
      if (c.error) lines.push(`  ${c.name}: ${c.error}`);
      for (const m of c.mismatches) lines.push(`  ${c.name}: ${formatMismatch(m)}`);
    }
    if (r.replay.staleCassettes.length) lines.push(`  stale cassettes (no matching case): ${r.replay.staleCassettes.join(', ')}`);
  }
  if (r.eval) {
    const e = r.eval;
    lines.push('', `Evals (${e.provider} ${e.model}, tools from ${e.source})`);
    lines.push(table([
      ['STATUS', 'SCENARIO', 'PASS RATE', 'ARG ACC', 'TOKENS IN/OUT', 'COST'],
      ...e.scenarios.map((s) => [s.passed ? 'PASS' : 'FAIL', s.name, `${pct(s.passRate)} (>=${pct(s.threshold)})`, pct(s.argAccuracy), `${s.usage.inputTokens}/${s.usage.outputTokens}`, usd(s.costUsd)]),
    ]));
    for (const s of e.scenarios) {
      for (const t of s.trials.filter((x) => !x.passed)) {
        lines.push(`  ${s.name} #${t.index + 1}: ${formatTrialFailure(t)}`);
      }
    }
    lines.push(`  total: ${e.totals.inputTokens} in / ${e.totals.outputTokens} out tokens, ${usd(e.totals.costUsd)}`);
  }
  return lines.join('\n') + '\n';
}
