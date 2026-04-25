# clawsweeper

Two AI-powered CLI tools for GitHub repository maintenance, both running Claude Code in headless mode with no Anthropic API key required.

---

## conductor

`conductor` is a plan / implement / review pipeline that uses Claude Code subagents to autonomously work a GitHub repo's issue backlog.

```
plan       →  Claude analyses the repo and creates GitHub issues via REST API
implement  →  Claude Code subagents implement each issue, push a branch, open a PR
review     →  Claude reviews each PR diff and posts a structured GitHub review
```

### How it actually works

**Plan** sends Claude a prompt about the target repo and asks it to return a JSON array of tasks. For each task it calls `POST /repos/{repo}/issues` directly using `curl` — no `gh` CLI, no extra dependencies. Issues get tagged with a label (default: `conductor`) so the other commands can find them.

**Implement** fetches open issues with that label and for each one spawns a Claude Code subagent via `claude --print --output-format json --permission-mode bypassPermissions`. The subagent runs inside the local checkout with full tool access — it reads files, edits code, runs tests, commits, pushes, and opens a PR. Each run is independent; results are saved to `conductor-state/implement-<N>.json`.

**Review** fetches open PRs, downloads each diff via the GitHub API, and sends it to Claude with a review prompt. Claude returns a structured JSON decision (`approve`, `request_changes`, or `comment`) plus a markdown review body, which gets posted to the PR via `POST /repos/{repo}/pulls/{pr}/reviews`.

Token usage is tracked from the `usage` field in each Claude CLI JSON envelope. When `--token-budget` is set the loop stops before the next item if accumulated tokens / budget >= `--usage-threshold` (default 90%).

### Live test — shibaeff/sample-python-service

Ran against a fresh private repo seeded with a ~100-line Python todo service and test file.

**Plan output (5 issues created, ~39k tokens):**

```
#1  Handle invalid item ID format with HTTP 400 instead of crashing
#2  Return HTTP 400 on malformed JSON request body instead of crashing
#3  Add PUT /items/<id> endpoint to update item done status
#4  Fix test isolation: reset _next_id between test cases
#5  Add thread safety with locks around shared mutable state
```

All five were real bugs and missing features in the seed code. Claude correctly identified that `int(path.split("/")[-1])` would throw an unhandled `ValueError` on non-integer IDs, that JSON parse errors propagated as 500s, that test cases shared global counter state, and that `HTTPServer` is single-threaded.

**Implement output (3 issues, ~609k tokens total):**

| Issue | PR | What the subagent did |
|-------|----|-----------------------|
| #5 thread safety | PR #6 | Added `threading.Lock()`, wrapped all `ITEMS` reads/writes, switched to `ThreadingHTTPServer` |
| #4 test isolation | PR #7 | Added `reset_state()` to `app.py`, called it in `setUp`, added a new regression test |
| #3 PUT endpoint | PR #8 | Implemented `do_PUT` with partial updates, input validation, locking, and 7 new test cases |

Subagents ran sequentially, each taking a few minutes. They left working, committed code on `conductor/issue-N` branches with proper commit messages and `Closes #N` PR bodies.

**Review output (3 PRs, ~195k tokens total):**

Claude reviewed all three PRs and posted GitHub reviews. The most interesting catch on PR #8 (PUT endpoint):

> *"There is one clear concurrency bug: in the 404 branch of `do_PUT`, `send_json` is called while `_lock` is still held, causing network I/O to block every other reader/writer of ITEMS for the duration of that write."*

That's a real bug — the subagent that implemented the feature called `self.send_json(404, ...)` from inside a `with _lock:` block, which holds the lock across a network write. The reviewer caught it correctly.

**Known gap:** implement subagents don't automatically apply the `--label conductor` to the PRs they create. Workaround: pass `--label ""` to `conductor:review` to review all open PRs, or add the label manually.

### Quick start

Requires Node 24 and the `claude` CLI logged in.

```bash
npm install
npm run build

export GITHUB_TOKEN=ghp_...
export CONDUCTOR_TARGET_REPO=owner/repo
export CONDUCTOR_REPO_DIR=/path/to/local/checkout

# Step 1 — create issues
npm run conductor:plan -- --max-issues 10 --plan-prompt "find bugs and missing features"

# Step 2 — implement them (3 at a time, stop at 90% of 500k token budget)
npm run conductor:implement -- --batch-size 3 --token-budget 500000

# Step 3 — review the PRs
npm run conductor:review -- --batch-size 5
```

### All flags

| Flag | Default | Description |
|------|---------|-------------|
| `--target-repo` | `CONDUCTOR_TARGET_REPO` env | `owner/repo` to operate on |
| `--token` | `GITHUB_TOKEN` env | GitHub PAT with `repo` scope |
| `--model` | `claude-sonnet-4-6` | Claude model |
| `--label` | `conductor` | Label filter for issues / PRs |
| `--state-dir` | `conductor-state` | Where to write JSON state files |
| `--token-budget` | `CONDUCTOR_TOKEN_BUDGET` env | Total token budget; enables usage guard |
| `--usage-threshold` | `90` | Stop at this % of token budget |
| `--max-issues` | `10` | *(plan)* Max issues to create |
| `--plan-prompt` | `CONDUCTOR_PLAN_PROMPT` env | *(plan)* What to look for |
| `--timeout-ms` | `120000` | *(plan)* Claude timeout |
| `--repo-dir` | `CONDUCTOR_REPO_DIR` env | *(implement)* Local checkout path |
| `--batch-size` | `3` | *(implement)* Issues per run |
| `--timeout-ms` | `600000` | *(implement)* Per-issue timeout |
| `--batch-size` | `5` | *(review)* PRs per run |
| `--auto-approve` | off | *(review)* Post APPROVE when Claude approves |
| `--timeout-ms` | `300000` | *(review)* Per-PR timeout |

---

## clawsweeper

`clawsweeper` is the original CLI in this repo. It scans all open issues and PRs in a target repository, reviews each one with an AI model, and proposes (or applies) closes for items that meet strict criteria.

Allowed close reasons:

- Already implemented on `main`
- Cannot reproduce on current `main`
- Too incoherent to be actionable
- Stale with insufficient data (60+ days, no new info)

Everything else stays open. It never closes without evidence.

### Target repo config

By default clawsweeper targets `openclaw/openclaw`. Override with env vars:

```bash
export CLAWSWEEPER_TARGET_REPO=owner/repo
export CLAWSWEEPER_REPORT_REPO=owner/clawsweeper-fork
```

### Runners

Two AI runners are supported:

**Codex (default):** requires `OPENAI_API_KEY`.

```bash
npm run review -- --openclaw-dir ../myrepo --codex-model gpt-5.5
```

**Claude Code (headless, no API key):** uses the logged-in `claude` CLI session.

```bash
npm run review -- --runner claude --openclaw-dir ../myrepo
```

With `--runner claude`, the model defaults to `claude-sonnet-4-6`. Override with `--codex-model`.

Token usage is tracked from the Claude CLI JSON output. Pass `--token-budget` and `--usage-threshold` to stop the review loop before exhausting your session quota:

```bash
npm run review -- --runner claude --openclaw-dir ../myrepo \
  --token-budget 500000 --usage-threshold 85
```

### Full local run

```bash
npm install
npm run build

# Plan which items need review
npm run plan -- --batch-size 5 --shard-count 40 --max-pages 250

# Review them
npm run review -- --openclaw-dir ../myrepo --artifact-dir artifacts/reviews \
  --runner claude --token-budget 500000

# Merge artifact files into items/
npm run apply-artifacts -- --artifact-dir artifacts/reviews

# Apply pending close proposals (careful — this writes to GitHub)
npm run apply-decisions -- --limit 20

# Dry-run reconcile closed/reopened items
npm run reconcile -- --dry-run
```

### Checks

```bash
npm run check      # build + lint + tests + format check
npm run oxformat   # auto-format (alias for oxfmt)
```

### GitHub Actions secrets

| Secret | Purpose |
|--------|---------|
| `OPENAI_API_KEY` | Codex runner login |
| `OPENCLAW_GH_TOKEN` | Write access to target repo for closing issues |
