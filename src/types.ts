// Shared types. Every module imports from here; nothing here imports runtime code.

export type JsonSchema = Record<string, unknown>;

export type ServerTarget =
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { transport: 'http'; url: string; headers?: Record<string, string> };

export type MatcherRule =
  | { path: string; match: 'ignore' }
  | { path: string; match: 'type' }
  | { path: string; match: 'regex'; pattern: string };

export interface RecordCase {
  name: string;
  tool: string;
  arguments?: Record<string, unknown>;
  /** Extra matchers for this case only; checked before the global replay.matchers. */
  matchers?: MatcherRule[];
  /** Extra keys ignored for this case only, added to replay.ignoreKeys. */
  ignoreKeys?: string[];
}

export type LintRule =
  | 'invalid-input-schema'
  | 'missing-description'
  | 'short-description'
  | 'vague-name'
  | 'param-missing-description'
  | 'name-style';

export interface LintOptions {
  minDescriptionLength: number;
  vagueNames: string[];
  disable: LintRule[];
}

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
}

export interface EvalSettings {
  model: string;
  trials: number;
  maxTurns: number;
  maxTokens: number;
  passThreshold: number;
  source: 'live' | 'cassette';
  system?: string;
  effort?: 'low' | 'medium' | 'high';
  pricing: Record<string, ModelPrice>;
}

export interface RedactOptions {
  keys: string[];
  patterns: string[];
}

/** What users write in mcp-eval.config.ts. Everything except `server` is optional. */
export interface McpEvalConfig {
  name?: string;
  server: ServerTarget;
  snapshotDir?: string;
  cassetteDir?: string;
  scenarioDir?: string;
  outDir?: string;
  redact?: Partial<RedactOptions>;
  lint?: Partial<LintOptions>;
  record?: { cases: RecordCase[] };
  replay?: { matchers?: MatcherRule[]; ignoreKeys?: string[] };
  eval?: Partial<EvalSettings>;
}

/** Config after defaults are applied. Directory fields are absolute paths. */
export interface ResolvedConfig {
  name: string;
  server: ServerTarget;
  rootDir: string;
  snapshotDir: string;
  cassetteDir: string;
  scenarioDir: string;
  outDir: string;
  redact: RedactOptions;
  lint: LintOptions;
  record: { cases: RecordCase[] };
  replay: { matchers: MatcherRule[]; ignoreKeys: string[] };
  eval: EvalSettings;
}

// ---------- snapshots ----------

export interface ToolSnapshot {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: Record<string, unknown>;
}

export interface PromptSnapshot {
  name: string;
  title?: string;
  description?: string;
  arguments: { name: string; description?: string; required: boolean }[];
}

export interface ResourceSnapshot {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface Snapshot {
  version: 1;
  server: { name: string; version: string };
  tools: ToolSnapshot[];
  prompts: PromptSnapshot[];
  resources: ResourceSnapshot[];
}

export type Severity = 'breaking' | 'risky' | 'safe';

export type ChangeKind =
  | 'tool-removed'
  | 'tool-added'
  | 'param-removed'
  | 'param-required-added'
  | 'param-optional-added'
  | 'param-became-required'
  | 'param-became-optional'
  | 'type-narrowed'
  | 'type-widened'
  | 'type-changed'
  | 'enum-value-removed'
  | 'enum-value-added'
  | 'constraint-narrowed'
  | 'constraint-widened'
  | 'description-changed'
  | 'annotation-changed'
  | 'output-schema-changed'
  | 'prompt-removed'
  | 'prompt-added'
  | 'prompt-arg-removed'
  | 'prompt-arg-required-added'
  | 'prompt-arg-optional-added'
  | 'resource-removed'
  | 'resource-added';

export interface Change {
  severity: Severity;
  kind: ChangeKind;
  /** e.g. "tool:create_note", "prompt:summarize", "resource:notes://all" */
  target: string;
  /** Dotted parameter path inside inputSchema, e.g. "filter.tags[]". */
  path?: string;
  message: string;
}

export interface LintIssue {
  rule: LintRule;
  level: 'error' | 'warning';
  target: string;
  path?: string;
  message: string;
}

// ---------- tool calls, cassettes, matching ----------

export interface ToolCallResult {
  content: unknown[];
  structuredContent?: unknown;
  isError: boolean;
}

export interface Cassette {
  version: 1;
  name: string;
  tool: string;
  arguments: Record<string, unknown>;
  response: ToolCallResult;
  server: { name: string; version: string };
  recordedAt: string;
}

export interface Mismatch {
  path: string;
  reason: 'value' | 'type' | 'missing' | 'extra' | 'length' | 'regex';
  expected?: unknown;
  actual?: unknown;
}

// ---------- evals ----------

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Check {
  kind: 'called' | 'not_called' | 'args' | 'order' | 'max_calls' | 'final_answer';
  description: string;
  passed: boolean;
  detail?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface TrialResult {
  index: number;
  passed: boolean;
  checks: Check[];
  calls: ToolCall[];
  finalAnswer: string;
  turns: number;
  usage: TokenUsage;
  error?: string;
}

export interface ScenarioResult {
  name: string;
  file?: string;
  threshold: number;
  passRate: number;
  /** Fraction of argument constraints satisfied over all trials; null when the scenario has none. */
  argAccuracy: number | null;
  passed: boolean;
  usage: TokenUsage;
  costUsd: number | null;
  trials: TrialResult[];
}

export interface EvalSummary {
  provider: string;
  model: string;
  source: 'live' | 'cassette';
  passed: boolean;
  scenarios: ScenarioResult[];
  totals: TokenUsage & { trials: number; passedTrials: number; costUsd: number | null };
}

// ---------- reports ----------

export interface ContractReport {
  snapshotPath: string;
  created: boolean;
  updated: boolean;
  changes: Change[];
  lint: LintIssue[];
  breaking: number;
  passed: boolean;
  /** True when lint errors themselves failed the contract (--fail-on-lint). */
  lintFailed?: boolean;
}

export interface ReplayCaseResult {
  name: string;
  tool: string;
  status: 'pass' | 'fail' | 'missing-cassette' | 'error';
  mismatches: Mismatch[];
  error?: string;
}

export interface ReplayReport {
  passed: boolean;
  cases: ReplayCaseResult[];
  staleCassettes: string[];
}

export interface RunReport {
  tool: 'mcp-eval-kit';
  version: string;
  generatedAt: string;
  server: string;
  contract?: ContractReport;
  replay?: ReplayReport;
  eval?: EvalSummary;
}
