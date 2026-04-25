/**
 * conductor — AI-driven plan / implement / review CLI
 *
 * plan:       Uses Claude to analyse a repo and creates GitHub issues via REST API (no gh CLI)
 * implement:  Implements open issues one-by-one using Claude Code subagents
 * review:     Reviews implementation PRs using Claude Code and posts the review to GitHub
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ─── types ───────────────────────────────────────────────────────────────────

interface Args {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

interface GHIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

interface GHPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface ClaudeResult {
  output: string;
  tokensUsed: number;
}

// ─── arg helpers ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2).replace(/-/g, "_");
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (arg) {
      args._.push(arg);
    }
  }
  return args;
}

function str(v: string | boolean | string[] | undefined, fallback: string): string {
  return typeof v === "string" && v ? v : fallback;
}

function num(v: string | boolean | string[] | undefined, fallback: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isNaN(n) ? fallback : n;
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

// ─── GitHub REST API (no gh CLI) ─────────────────────────────────────────────

function ghApi(method: string, path: string, token: string, body?: unknown): unknown {
  const curlArgs = [
    "-s",
    "-X",
    method,
    "-H",
    `Authorization: token ${token}`,
    "-H",
    "Content-Type: application/json",
    "-H",
    "Accept: application/vnd.github.v3+json",
  ];
  if (body) curlArgs.push("-d", JSON.stringify(body));
  curlArgs.push(`https://api.github.com/${path}`);

  const r = spawnSync("curl", curlArgs, { encoding: "utf8", timeout: 30_000 });
  if (r.error) throw new Error(`GitHub API request failed: ${r.error.message}`);
  return JSON.parse(r.stdout) as unknown;
}

function createIssue(
  repo: string,
  token: string,
  title: string,
  body: string,
  labels: string[],
): GHIssue {
  return ghApi("POST", `repos/${repo}/issues`, token, { title, body, labels }) as GHIssue;
}

function listOpenIssues(repo: string, token: string, label?: string): GHIssue[] {
  const issues: GHIssue[] = [];
  let page = 1;
  while (true) {
    const labelParam = label ? `&labels=${encodeURIComponent(label)}` : "";
    const batch = ghApi(
      "GET",
      `repos/${repo}/issues?state=open&per_page=100&page=${page}${labelParam}`,
      token,
    ) as GHIssue[];
    issues.push(...batch.filter((i) => !i.pull_request));
    if (batch.length < 100) break;
    page++;
  }
  return issues;
}

function listOpenPRs(repo: string, token: string, label?: string): GHPR[] {
  const prs: GHPR[] = [];
  let page = 1;
  while (true) {
    const labelParam = label ? `&labels=${encodeURIComponent(label)}` : "";
    const batch = ghApi(
      "GET",
      `repos/${repo}/pulls?state=open&per_page=100&page=${page}${labelParam}`,
      token,
    ) as GHPR[];
    prs.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return prs;
}

function getPRDiff(repo: string, token: string, prNumber: number): string {
  const r = spawnSync(
    "curl",
    [
      "-s",
      "-H",
      `Authorization: token ${token}`,
      "-H",
      "Accept: application/vnd.github.v3.diff",
      `https://api.github.com/repos/${repo}/pulls/${prNumber}`,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  return r.stdout;
}

function postPRReview(
  repo: string,
  token: string,
  prNumber: number,
  body: string,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
): void {
  ghApi("POST", `repos/${repo}/pulls/${prNumber}/reviews`, token, { body, event });
}

// ─── Claude CLI runner (headless, no API key required) ───────────────────────

function runClaude(prompt: string, workDir: string, model: string, timeoutMs: number): ClaudeResult {
  const r = spawnSync(
    "claude",
    [
      "--print",
      "--model",
      model,
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--no-session-persistence",
      prompt,
    ],
    { cwd: workDir, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: timeoutMs },
  );

  if (r.error) throw new Error(`Claude failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `Claude exited ${r.status ?? "unknown"}:\n${r.stderr.slice(-3000) || r.stdout.slice(-3000)}`,
    );
  }

  const envelope = JSON.parse(r.stdout.trim()) as Record<string, unknown>;
  if (envelope.is_error) {
    throw new Error(
      `Claude error: ${typeof envelope.result === "string" ? envelope.result : JSON.stringify(envelope.result)}`,
    );
  }

  const u = (envelope.usage ?? {}) as Record<string, unknown>;
  const tokensUsed =
    (Number(u.input_tokens) || 0) +
    (Number(u.output_tokens) || 0) +
    (Number(u.cache_read_input_tokens) || 0) +
    (Number(u.cache_creation_input_tokens) || 0);

  const raw = envelope.result;
  return { output: typeof raw === "string" ? raw : JSON.stringify(raw), tokensUsed };
}

function parseJsonOutput<T>(output: string, fallback: T): T {
  try {
    return JSON.parse(output.trim()) as T;
  } catch {
    return fallback;
  }
}

// ─── Usage guard (shared by implement + review) ───────────────────────────────

function checkUsage(accumulated: number, budget: number, threshold: number, tag: string): boolean {
  if (threshold <= 0 || budget <= 0) return false;
  const pct = (accumulated / budget) * 100;
  console.error(`[${tag}] Session usage: ${pct.toFixed(1)}% (${accumulated}/${budget} tokens)`);
  if (pct >= threshold) {
    console.error(`[${tag}] Usage threshold ${threshold}% reached, stopping.`);
    return true;
  }
  return false;
}

// ─── plan ─────────────────────────────────────────────────────────────────────

function planCommand(args: Args): void {
  const targetRepo = str(args.target_repo, process.env.CONDUCTOR_TARGET_REPO ?? "");
  const token = str(args.token, process.env.GITHUB_TOKEN ?? "");
  const model = str(args.model, "claude-sonnet-4-6");
  const maxIssues = num(args.max_issues, 10);
  const label = str(args.label, "conductor");
  const stateDir = resolve(str(args.state_dir, "conductor-state"));
  const timeoutMs = num(args.timeout_ms, 120_000);
  const planPrompt = str(
    args.plan_prompt,
    process.env.CONDUCTOR_PLAN_PROMPT ??
      "Identify the most valuable improvements, bugs, or missing features in this repository.",
  );

  if (!targetRepo) throw new Error("--target-repo or CONDUCTOR_TARGET_REPO is required");
  if (!token) throw new Error("--token or GITHUB_TOKEN is required for issue creation");

  ensureDir(stateDir);

  console.error(`[plan] Analysing ${targetRepo} with Claude (${model})…`);

  const prompt = `You are a software engineering planner. Analyse the GitHub repository ${targetRepo} and ${planPrompt}

Return a JSON array of up to ${maxIssues} issues to create. Each element must have:
- "title": concise, actionable issue title (string)
- "body": detailed description with context and acceptance criteria (string, markdown)

Return ONLY the JSON array with no surrounding text or code fences.`;

  const { output, tokensUsed } = runClaude(prompt, ROOT, model, timeoutMs);

  const tasks = parseJsonOutput<Array<{ title: string; body: string }>>(output, []);
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`Claude returned no tasks. Raw output:\n${output.slice(0, 2000)}`);
  }

  console.error(`[plan] Creating ${tasks.length} issues in ${targetRepo} (tokens used: ${tokensUsed})`);

  const created: Array<{ number: number; title: string; url: string }> = [];
  for (const task of tasks) {
    const issue = createIssue(targetRepo, token, task.title, task.body, [label]);
    console.error(`[plan]   #${issue.number}: ${issue.title}`);
    created.push({ number: issue.number, title: issue.title, url: issue.html_url });
  }

  const planFile = join(stateDir, "plan.json");
  writeFileSync(
    planFile,
    JSON.stringify({ targetRepo, created, createdAt: new Date().toISOString() }, null, 2),
  );
  console.log(JSON.stringify({ created }, null, 2));
  console.error(`[plan] Saved to ${planFile}`);
}

// ─── implement ────────────────────────────────────────────────────────────────

function implementCommand(args: Args): void {
  const targetRepo = str(args.target_repo, process.env.CONDUCTOR_TARGET_REPO ?? "");
  const token = str(args.token, process.env.GITHUB_TOKEN ?? "");
  const repoDir = resolve(str(args.repo_dir, process.env.CONDUCTOR_REPO_DIR ?? "."));
  const model = str(args.model, "claude-sonnet-4-6");
  const label = str(args.label, "conductor");
  const batchSize = num(args.batch_size, 3);
  const timeoutMs = num(args.timeout_ms, 600_000);
  const stateDir = resolve(str(args.state_dir, "conductor-state"));
  const usageThreshold = num(args.usage_threshold, 90);
  const tokenBudget =
    num(args.token_budget, 0) ||
    parseInt(process.env.CONDUCTOR_TOKEN_BUDGET ?? "0");

  if (!targetRepo) throw new Error("--target-repo or CONDUCTOR_TARGET_REPO is required");
  if (!repoDir) throw new Error("--repo-dir or CONDUCTOR_REPO_DIR is required");

  ensureDir(stateDir);

  const issues = listOpenIssues(targetRepo, token, label);
  const candidates = issues.slice(0, batchSize);
  console.error(
    `[implement] ${issues.length} open issues labelled "${label}", processing up to ${batchSize}`,
  );

  let accumulatedTokens = 0;
  let completed = 0;

  for (const issue of candidates) {
    if (checkUsage(accumulatedTokens, tokenBudget, usageThreshold, "implement")) break;

    console.error(`[implement] Starting #${issue.number}: ${issue.title}`);

    const branch = `conductor/issue-${issue.number}`;
    const prompt = `You are a software engineer implementing a GitHub issue. The repository is already checked out at your current working directory.

Issue #${issue.number}: ${issue.title}
URL: ${issue.html_url}

${issue.body ?? ""}

Steps to follow:
1. Create and switch to a new branch:
   git checkout -b ${branch}
2. Implement the changes required to resolve the issue. Write clean, well-tested code.
3. If there are existing tests, make sure they still pass. Add new tests where appropriate.
4. Commit all changes:
   git commit -m "fix: <short description> (#${issue.number})"
5. Push the branch:
   git push origin ${branch}
6. Open a pull request:
   gh pr create --title "<PR title>" --body "Closes #${issue.number}\\n\\n<description of changes>" --base main

When done, output a JSON object with these fields:
{
  "issueNumber": ${issue.number},
  "branch": "${branch}",
  "prNumber": <number from gh pr create output>,
  "prUrl": "<full PR URL>",
  "summary": "<one paragraph describing what was implemented>"
}`;

    try {
      const { output, tokensUsed } = runClaude(prompt, repoDir, model, timeoutMs);
      accumulatedTokens += tokensUsed;

      const result = parseJsonOutput<Record<string, unknown>>(output, {
        issueNumber: issue.number,
        summary: output.slice(0, 500),
        parseError: true,
      });

      writeFileSync(
        join(stateDir, `implement-${issue.number}.json`),
        JSON.stringify(
          { ...result, tokensUsed, completedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
      console.error(
        `[implement] Done #${issue.number} → PR: ${result.prUrl ?? "unknown"} (tokens: ${tokensUsed})`,
      );
      completed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[implement] Failed #${issue.number}: ${msg.slice(0, 300)}`);
      writeFileSync(
        join(stateDir, `implement-${issue.number}-error.json`),
        JSON.stringify({ issueNumber: issue.number, error: msg, failedAt: new Date().toISOString() }, null, 2),
      );
    }
  }

  console.error(`[implement] Complete: ${completed}/${candidates.length} implemented`);
}

// ─── review ───────────────────────────────────────────────────────────────────

function reviewCommand(args: Args): void {
  const targetRepo = str(args.target_repo, process.env.CONDUCTOR_TARGET_REPO ?? "");
  const token = str(args.token, process.env.GITHUB_TOKEN ?? "");
  const model = str(args.model, "claude-sonnet-4-6");
  const label = str(args.label, "conductor");
  const batchSize = num(args.batch_size, 5);
  const timeoutMs = num(args.timeout_ms, 300_000);
  const stateDir = resolve(str(args.state_dir, "conductor-state"));
  const autoApprove = args.auto_approve === true;
  const usageThreshold = num(args.usage_threshold, 90);
  const tokenBudget =
    num(args.token_budget, 0) ||
    parseInt(process.env.CONDUCTOR_TOKEN_BUDGET ?? "0");

  if (!targetRepo) throw new Error("--target-repo or CONDUCTOR_TARGET_REPO is required");
  if (!token) throw new Error("--token or GITHUB_TOKEN is required");

  ensureDir(stateDir);

  const prs = listOpenPRs(targetRepo, token, label);
  const candidates = prs.slice(0, batchSize);
  console.error(
    `[review] ${prs.length} open PRs labelled "${label}", reviewing up to ${batchSize}`,
  );

  let accumulatedTokens = 0;
  let completed = 0;

  for (const pr of candidates) {
    if (checkUsage(accumulatedTokens, tokenBudget, usageThreshold, "review")) break;

    console.error(`[review] Reviewing PR #${pr.number}: ${pr.title}`);

    const diff = getPRDiff(targetRepo, token, pr.number);

    const prompt = `You are a thorough code reviewer. Review this pull request carefully.

Repository: ${targetRepo}
PR #${pr.number}: ${pr.title}
URL: https://github.com/${targetRepo}/pull/${pr.number}
Branch: ${pr.head.ref} → ${pr.base.ref}

PR Description:
${pr.body ?? "(no description)"}

Diff (truncated to 50k chars):
\`\`\`diff
${diff.slice(0, 50_000)}
\`\`\`

Evaluate:
- Correctness and logic
- Security vulnerabilities
- Test coverage
- Code quality and consistency with the surrounding codebase
- Whether the change fully resolves the stated goal

Return a JSON object with these fields:
{
  "decision": "approve" | "request_changes" | "comment",
  "summary": "<one paragraph summary>",
  "issues": [{ "severity": "blocking" | "suggestion", "description": "<detail>" }],
  "reviewBody": "<full review text in markdown, suitable for posting as a PR review>"
}`;

    try {
      const { output, tokensUsed } = runClaude(prompt, ROOT, model, timeoutMs);
      accumulatedTokens += tokensUsed;

      const review = parseJsonOutput<{
        decision?: string;
        reviewBody?: string;
        summary?: string;
        issues?: unknown[];
      }>(output, { decision: "comment", reviewBody: output.slice(0, 3000) });

      const event =
        autoApprove && review.decision === "approve"
          ? "APPROVE"
          : review.decision === "request_changes"
            ? "REQUEST_CHANGES"
            : "COMMENT";

      if (review.reviewBody) {
        postPRReview(targetRepo, token, pr.number, review.reviewBody, event);
      }

      writeFileSync(
        join(stateDir, `review-${pr.number}.json`),
        JSON.stringify(
          { ...review, prNumber: pr.number, tokensUsed, reviewedAt: new Date().toISOString() },
          null,
          2,
        ),
      );
      console.error(
        `[review] Done PR #${pr.number} — ${review.decision ?? "comment"} (tokens: ${tokensUsed})`,
      );
      completed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[review] Failed PR #${pr.number}: ${msg.slice(0, 300)}`);
    }
  }

  console.error(`[review] Complete: ${completed}/${candidates.length} reviewed`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

const USAGE = `
conductor — AI-driven plan / implement / review

Commands:
  plan        Analyse a repo with Claude and create GitHub issues
  implement   Implement open issues one-by-one with Claude Code subagents
  review      Review implementation PRs with Claude Code

Common flags:
  --target-repo  owner/repo          Target GitHub repository
  --token        <github-token>      GitHub personal access token (or GITHUB_TOKEN env var)
  --model        <claude-model>      Claude model (default: claude-sonnet-4-6)
  --label        <label>             Issue/PR label filter (default: conductor)
  --state-dir    <path>              Directory for state files (default: conductor-state)
  --token-budget <n>                 Total token budget for session (enables usage threshold)
  --usage-threshold <0-100>          Stop when this % of token budget is used (default: 90)

plan flags:
  --max-issues   <n>                 Max issues to create (default: 10)
  --plan-prompt  "<text>"            Instruction for what to plan (or CONDUCTOR_PLAN_PROMPT)
  --timeout-ms   <ms>                Claude timeout (default: 120000)

implement flags:
  --repo-dir     <path>              Local checkout of target repo (or CONDUCTOR_REPO_DIR)
  --batch-size   <n>                 Issues to implement per run (default: 3)
  --timeout-ms   <ms>                Per-issue Claude timeout (default: 600000)

review flags:
  --batch-size   <n>                 PRs to review per run (default: 5)
  --auto-approve                     Post APPROVE when Claude decides to approve
  --timeout-ms   <ms>                Per-PR Claude timeout (default: 300000)

Environment variables:
  CONDUCTOR_TARGET_REPO              Fallback for --target-repo
  GITHUB_TOKEN                       Fallback for --token
  CONDUCTOR_REPO_DIR                 Fallback for --repo-dir
  CONDUCTOR_PLAN_PROMPT              Fallback for --plan-prompt
  CONDUCTOR_TOKEN_BUDGET             Fallback for --token-budget
`.trim();

try {
  if (command === "plan") {
    planCommand(args);
  } else if (command === "implement") {
    implementCommand(args);
  } else if (command === "review") {
    reviewCommand(args);
  } else {
    console.error(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (err) {
  console.error(`[conductor] Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
