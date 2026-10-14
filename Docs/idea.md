# Prowl — Build Specification v2

> Supersedes `prowl.md` (v1 idea doc). This is the document a coding agent builds from.
> Companion file: `PROWL_AGENT_GUIDE.md` (the usage card that *consuming* agents read).

---

## 0. Instructions for the building agent

1. Read this whole document before writing code.
2. Build **milestone by milestone** (§15). Do not start milestone N+1 until every acceptance test of milestone N passes.
3. Write the acceptance tests **first**; they are the definition of done.
4. Anything in **Non-goals** (§1.3) is forbidden in v1, even if it looks easy.
5. Sections marked **DECISION GATE** require you to stop, write `docs/DECISION_<name>.md` with measured data, and wait for the human.
6. Security requirements (§9, §10) are requirements, not suggestions. A feature that cannot satisfy them ships disabled.
7. Every command supports `--json` and obeys the output envelope (§5). No command prints free-form text outside the envelope.
8. If this spec is ambiguous, pick the simpler option, record it in `docs/DECISIONS.md`, and continue.
9. Pin dependency versions. Do not add a dependency without a one-line justification in `docs/DECISIONS.md`.

---

## 1. Product definition

### 1.1 One-liner

Prowl is a **local browser daemon + thin CLI** that lets any agent — vision or not — operate websites cheaply and safely: logged-in sessions whose secrets the model never reads, compact token-budgeted output, and guaranteed cleanup of every browser it starts.

### 1.2 Who uses it

- Coding/desktop agents (Claude Code, OpenCode, etc.) calling the CLI or MCP server
- Scripts and n8n workflows calling the CLI
- The human operator (login handoff, session inspection)

**Use cases, ranked (build for #1 first):**

1. Test the operator's own web app (localhost/staging) with a logged-in profile
2. Operate third-party web apps the operator has accounts on and permission to automate
3. Read JS-heavy or gated pages when plain HTTP fetch fails
4. Reach harder public pages via *pluggable* stealth backends (optional, last)

### 1.3 Non-goals (v1)

- A custom fingerprint-spoofing engine (we integrate existing backends instead — §13)
- CAPTCHA solving or solver-service integrations
- Buying/operating proxy networks (user supplies proxies)
- Self-hosting Firecrawl, document conversion (`anydoc`, `pdf-inspector`), or the open-catalog project — these are separate tools; Prowl only offers optional adapter hooks (§14)
- GUI, cloud hosting, multi-user/multi-tenant operation
- Bypassing authentication, paywalls, or access controls

### 1.4 Differentiation (why not just use an existing tool)

Existing tools (e.g. `agent-browser`, Playwright MCP) already provide a daemon, accessibility snapshots with element refs, and sessions. Prowl must not merely re-implement those. Its reasons to exist:

| Differentiator | What it means |
| --- | --- |
| Auth without secret exposure | Domain-bound profiles, secret refs resolved only inside the daemon, output scrubbing, eval gating, login handoff |
| Tier-aware output | Same verbs, but budgets/defaults tuned for vision, CLI, and no-vision models |
| Fetch-first escalation ladder | HTTP fetch → browser → profile → stealth backend → human, with typed reasons and hard limits |
| Lease-based lifecycle | Browsers cannot outlive their owner; leak count is a tested metric |
| Structured site memory | Verified hints, not free-text notes |

**DECISION GATE M0** (§15) decides whether to build these on top of an existing tool or from scratch.

---

## 2. Principles

- **P1 Snapshot-first.** Agents act on refs from an accessibility snapshot, not hand-written CSS selectors.
- **P2 Tokens are a feature.** Every output has a budget; full data goes to an artifact file.
- **P3 Secrets never cross the model boundary** (defense in depth, §9).
- **P4 Page content is untrusted input,** never instructions (§10).
- **P5 No leaked browsers.** Ever.
- **P6 Degrade by tier.** Tier 3 (no vision, small model) must be able to do everything essential.
- **P7 Fail loud, fail typed.** Every error has a code, a hint, and a retryable flag.
- **P8 No infinite loops.** Every retry/escalation has a hard cap and a reason code.
- **P9 Local by default.** Nothing listens on a network port. IPC is a Unix socket / named pipe with user-only permissions.

---

## 3. Architecture

```text
agent / script
     │  (CLI call or MCP tool call)
     ▼
prowl (thin CLI client)  ──── Unix socket / named pipe (0600) ────►  prowld (daemon, one per user)
                                                                       ├─ Router (validates, policy check, audit)
                                                                       ├─ SessionManager (leases, reaper, locks)
                                                                       ├─ BackendRegistry
                                                                       │     ├─ playwright-chromium (default)
                                                                       │     ├─ system-chrome (dedicated profile)
                                                                       │     ├─ cdp-attach (user-launched Chrome)
                                                                       │     ├─ patchright (optional)
                                                                       │     └─ camoufox sidecar (optional, M6)
                                                                       ├─ Snapshotter (a11y tree → refs → diff)
                                                                       ├─ Extractor (readability → markdown/json)
                                                                       ├─ Fetcher (HTTP, no browser)
                                                                       ├─ AuthVault (secret refs, scrubber, policies)
                                                                       ├─ MemoryStore (SQLite)
                                                                       └─ ChallengeDetector
```

### 3.1 Why a daemon

Each CLI invocation is a short-lived process; browsers must persist between commands. The daemon owns browsers and exposes verbs. The CLI auto-starts the daemon on first use, and the daemon exits after `daemon.idle_exit_minutes` (default 15) with zero sessions.

### 3.2 Technology decisions

| Decision | Choice | Why | Revisit if |
| --- | --- | --- | --- |
| Language | TypeScript, Node ≥ 20 | Fast iteration, npm distribution, Playwright first-class | Memory/startup becomes a measured bottleneck → port daemon only |
| Browser lib | Playwright core, behind `BrowserBackend` interface | Mature, a11y snapshot support | Stealth results require direct-CDP backend |
| Storage | `better-sqlite3` | Sync, reliable, single file | — |
| CLI parsing | `cac` or `commander` | Small | — |
| Schemas | `zod`; generate JSON Schema for MCP and `prowl schema` | One source of truth | — |
| HTML→MD | Mozilla Readability + `turndown` (or `defuddle`) | Proven | Quality tests fail |
| Secrets | OS keychain via a maintained Node keyring binding; fallback age-encrypted file | §9 | — |
| IPC | JSON-RPC 2.0 over Unix socket / named pipe | Simple, no ports | — |
| Packaging | npm first; Node SEA/Bun binary later | — | — |

> **Note:** Do not assume the JS ecosystem is best for stealth. Current public benchmarks favor tools that drive real Chrome directly (e.g. nodriver, Python) or patched forks (Patchright, Camoufox). That is why Prowl abstracts the backend (§13) rather than baking in one library.

### 3.3 Backend interface

```ts
interface BrowserBackend {
  id: string;                                  // "playwright-chromium" | "system-chrome" | "cdp-attach" | ...
  capabilities: { headed: boolean; a11ySnapshot: boolean; cdpRaw: boolean; fingerprintTools: boolean };
  launch(opts: LaunchOpts): Promise<BrowserHandle>;   // profileDir, headless, proxy, locale, tz, viewport
  attach?(cdpUrl: string): Promise<BrowserHandle>;
  // BrowserHandle exposes: pages, snapshot(), act(ref, action), eval(), cookies(), close(), pid
}
```

Every backend must pass the same conformance test suite (§16) before it is registered.

### 3.4 Repository layout

```text
prowl/
  src/
    cli/            # thin client, arg parsing, formatting
    daemon/         # server, router, policy, audit
    session/        # manager, lease, reaper, locks
    backends/       # one dir per backend + conformance tests
    snapshot/       # tree building, refs, diff
    extract/        # readability, markdown, tables, links
    fetch/          # http fetcher, robots, ladder driver
    auth/           # vault, profiles, scrubber, handoff, totp
    memory/         # sqlite store, hint verification
    detect/         # challenge detector
    mcp/            # MCP adapter (M5)
    schema/         # zod schemas, envelope
  tests/
    fixture-app/    # §16
    acceptance/     # one file per milestone
    security/
  docs/
    DECISIONS.md  DECISION_M0.md  AUTH.md  STEALTH.md
  PROWL_AGENT_GUIDE.md
```

---

## 4. Interaction model: snapshots and refs

### 4.1 Snapshot

`prowl snapshot` returns the accessibility tree as compact text plus a ref table.

```text
[page] https://app.local/login  "Sign in"   gen=3
[e1] textbox "Email" value="" required
[e2] textbox "Password" value="••••" required        # password values are ALWAYS masked
[e3] checkbox "Remember me" checked=false
[e4] button "Sign in"
[e5] link "Forgot password?" href=/reset
```

Rules:

- Ref format `e<N>`; refs inside iframes use `f<M>:e<N>`.
- Refs are valid for the current **page generation** (`gen`). Navigation or significant DOM mutation increments `gen`.
- A stale ref returns `STALE_REF` with hint `re-run snapshot`. Where possible the daemon first tries re-resolution by (role, name, nth) and succeeds silently; the result includes `"re_resolved": true`.
- Include only: role, accessible name, value, state (checked/disabled/expanded/selected), `href` for links, heading level. Exclude decorative/hidden nodes.
- Open shadow DOM is pierced. Closed shadow roots are reported as `[opaque]`.
- Modes: `-i` interactive-only (default for Tier 3), `--scope <ref|css>`, `--depth N`, `--diff` (only changes since previous snapshot), `--max-bytes N`.
- Fallback for unlabeled targets: `prowl find --role button --name "Save"` and `prowl find --text "Add to cart"` return refs. `click`/`fill` also accept `--role/--name` and `--text` directly.

### 4.2 Observe-after-act

Every action command (`click`, `fill`, `type`, `press`, `select`, `check`, `scroll`, …) returns an `observe` block by default (disable with `--no-observe`):

```json
"observe": {
  "url_changed": true, "url": "https://app.local/dashboard", "gen": 4,
  "dialog": null, "download": null,
  "diff": { "added": 12, "removed": 9, "summary": ["+ heading 'Dashboard'", "+ button 'New item'", "- button 'Sign in'"] }
}
```

This keeps small models from needing a separate snapshot after every step.

### 4.3 Waiting

All actions auto-wait for actionability (visible, enabled, stable) with a default 5 s timeout. `wait` supports `--selector`, `--text`, `--url`, `--network-idle`, `--ms` (capped at 30 000). No unbounded waits anywhere.

---

## 5. Output contract

### 5.1 JSON envelope (all commands, `--json`)

```json
{
  "ok": true,
  "command": "click",
  "session": "dev",
  "url": "https://app.local/dashboard",
  "title": "Dashboard",
  "status": 200,
  "blocked": null,
  "data": {},
  "observe": {},
  "truncated": false,
  "artifact": null,
  "tokens_est": 312,
  "ms": 184,
  "warnings": []
}
```

Error form:

```json
{ "ok": false, "error": { "code": "AUTH_REQUIRED", "message": "Profile 'local-dev' is not logged in",
  "hint": "Ask the operator to run: prowl auth login http://localhost:3000 --profile local-dev",
  "retryable": false, "details": {} } }
```

### 5.2 Error codes

`AUTH_REQUIRED`, `STALE_REF`, `NOT_FOUND`, `AMBIGUOUS_TARGET`, `TIMEOUT`, `NAVIGATION_FAILED`, `BLOCKED_CHALLENGE`, `POLICY_DENIED`, `CONFIRMATION_REQUIRED`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `SESSION_CRASHED`, `PROFILE_LOCKED`, `BACKEND_UNAVAILABLE`, `DOCUMENT_DETECTED`, `USAGE`, `INTERNAL`.

### 5.3 Exit codes

`0` ok · `1` generic · `2` usage · `3` AUTH_REQUIRED · `4` BLOCKED_CHALLENGE · `5` TIMEOUT · `6` POLICY_DENIED / CONFIRMATION_REQUIRED · `7` STALE_REF / NOT_FOUND / AMBIGUOUS_TARGET.

### 5.4 Markdown mode (default for humans and Tier 1/2)

YAML frontmatter (`url`, `title`, `timestamp`, `status`, `bytes`, `sha256`, `blocked`, `truncated`, `artifact`) followed by the body.

### 5.5 Truncation and artifacts

- `--max-bytes N`; defaults by tier: T1 20 000 · T2 12 000 · T3 6 000.
- On truncation: `"truncated": true` and `"artifact": "art_<id>"`; full content stored at `~/.prowl/artifacts/<session>/<id>.<ext>`.
- `prowl artifact read <id> [--range START:END]` pages through it.

### 5.6 Untrusted-content marking

Any field derived from page content carries `"untrusted": true` in JSON; in Markdown mode the body is wrapped:

```text
<<<PAGE_CONTENT untrusted=true source=https://example.com>>>
...
<<<END_PAGE_CONTENT>>>
```

---

## 6. Model tiers (defaults via `--tier 1|2|3` or `PROWL_TIER`)

| | Tier 1 (computer-use) | Tier 2 (CLI + optional vision) | Tier 3 (text-only, small) |
| --- | --- | --- | --- |
| Output | Markdown | Markdown + `--json` | **JSON only** |
| Snapshot default | full | interactive + scope | interactive-only, compact |
| `observe` after act | on | on | on, diff summary capped to 10 lines |
| Screenshots | allowed | on request | **never offered** |
| `--max-bytes` | 20 000 | 12 000 | 6 000 |
| Batch plans (`prowl run`) | optional | encouraged | encouraged |
| Confirmation prompts | via handoff | via flag | via flag (`--yes` only if profile policy permits) |

Tier 3 rule: no command may *require* a screenshot, coordinates, or hover-only discovery.

### 6.1 Plan runner

`prowl run plan.json` executes ordered steps in one call, stops at first failure, and returns per-step envelopes. Steps reference refs only through `find` results or role/name/text locators (refs from one snapshot are not reliable across steps).

```json
{ "session": "dev", "profile": "local-dev", "steps": [
  { "cmd": "goto", "url": "http://localhost:3000/items" },
  { "cmd": "click", "role": "button", "name": "New item" },
  { "cmd": "fill", "label": "Title", "value": "Test item" },
  { "cmd": "click", "role": "button", "name": "Save" },
  { "cmd": "assert", "text": "Test item saved" } ] }
```

---

## 7. Command reference (v1)

```text
# lifecycle
prowl open <url> [--session S] [--profile P] [--backend B] [--headed] [--ephemeral] [--owner O] [--ttl 10m]
prowl close [--session S]            prowl session list | kill <id|all> | gc
prowl daemon status | stop           prowl doctor

# navigation
prowl goto <url> [--wait load|domcontentloaded|networkidle|selector:<css>]
prowl back | forward | reload
prowl tabs list | switch <n> | close <n>
prowl wait [--selector css] [--text t] [--url glob] [--network-idle] [--ms N]

# observation
prowl snapshot [-i] [--scope X] [--depth N] [--diff] [--max-bytes N]
prowl find (--role r --name n | --text t | --label l)
prowl extract [--format markdown|json|links|tables|text] [--clean] [--select css] [--max-bytes N] [--out file]
prowl get url|title|text <ref>|attr <ref> <name>
prowl screenshot [--full] [--ref R] [--path p.png] [--max-width N]       # Tier 1/2 only
prowl console [--since N] [--level error]    prowl network [--failed] [--since N]   # scrubbed (§9.5)

# action (all accept --role/--name/--text/--label instead of a ref; all return observe)
prowl click <ref>        prowl fill <ref> <value|--secret NAME|--totp NAME>
prowl type <ref> <text> [--press Enter]      prowl press <key>
prowl select <ref> <value>    prowl check|uncheck <ref>    prowl hover <ref>
prowl scroll [down|up|top|bottom] [--pixels N] [--to <ref>]
prowl upload <ref> <path>     prowl download list|get <id>    prowl dialog accept|dismiss [--text t]

# fetch & ladder
prowl fetch <url> [--max-bytes N]                       # no browser; readability → markdown
prowl read <url> [--max-level 0..4] [--profile P]       # runs the escalation ladder (§12)

# escape hatch (policy-gated, §9.5)
prowl eval "<js>" [--json]

# state
prowl state save <name> | load <name> | list | delete <name>

# auth (operator-facing; agents may call list/whoami/verify only)
prowl auth profiles list | create <name> --domains a.com,b.com [--risk low|med|high]
prowl auth login <url> --profile P            # headed handoff
prowl auth import-cookies <file> --profile P
prowl auth whoami|verify --profile P
prowl auth secret set|rm|list <NAME>          # secret value via stdin/prompt only
prowl auth policy show|set --profile P ...
prowl auth rotate|delete --profile P

# memory
prowl memory show|search <q>|add|forget <id>|clear [--domain d]

# human handoff
prowl handoff [--reason "solve captcha"]      # makes session headed, pauses agent commands, returns on `prowl resume`
prowl resume

# integration
prowl run plan.json        prowl mcp        prowl schema [--format json-schema|mcp]
```

Notes:

- `--session` defaults to `default`. If `--profile` is given without a session, the session is named after the profile.
- Secrets are **never** accepted as plain CLI arguments. Accepted forms: stdin, `@env:NAME`, `@file:path`, `@keychain:NAME`.

---

## 8. Sessions and lifecycle

### 8.1 Session record

`{ id, name, backend, profile|null, mode: ephemeral|persistent, owner, created_at, last_activity_at, ttl, state: starting|ready|busy|handoff|crashed|closed, browser_pid, profile_dir }`

### 8.2 Leases and the reaper

- **Owner** = `--owner` flag, else `PROWL_OWNER` env, else the nearest non-shell ancestor PID of the calling CLI process.
- Reaper tick every 15 s:
  - `now - last_activity > ttl` (default 10 min) → close session, save memory.
  - Owner PID dead → 60 s grace → close (the grace allows an agent to restart and re-attach with the same `--owner`).
  - `now - created_at > max_lifetime` (default 2 h) → close.
- Ephemeral profile dirs live in `$TMPDIR/prowl-<sessionId>/` and are wiped on close **and** at daemon start (orphan sweep).
- On daemon startup: reconcile sessions from SQLite; kill any browser whose `user-data-dir` path matches a `prowl-*` or `~/.prowl/profiles/*` directory but is not tracked.
- If the daemon is killed (`kill -9`), the next daemon start (or `prowl gc`) must clean up all orphans. Browsers launched by Prowl must also be started so that they exit when their parent daemon dies where the OS permits (process groups / `PR_SET_PDEATHSIG` on Linux, job objects on Windows).

### 8.3 Concurrency

- Commands within one session are serialized (FIFO queue). A command waiting > `queue_timeout` (30 s) returns `SESSION_BUSY`.
- Different sessions run in parallel; default `max_sessions = 4`.
- **One live session per persistent profile** (Chromium locks profile dirs). A second `open` returns `PROFILE_LOCKED` with the holder session id and a hint to reuse it.

### 8.4 Crash handling

Browser process exit → state `crashed`; next command returns `SESSION_CRASHED` with hint; `prowl open --session S` restarts using the same profile.

---

## 9. Auth and secrets

### 9.1 Threat model (be honest in docs/AUTH.md)

Protects against:

- (a) the model reading plaintext credentials from prompts, tool output, logs, memory, or artifacts
- (b) credentials persisting where an agent can later read them
- (c) a prompt-injected page steering the agent to use the session on unrelated domains

Does **not** protect against: an agent that is allowed to drive a logged-in session acting as the user *within the profile's allowed domains*. **A logged-in profile is a capability.** Risk is reduced through domain scoping, action confirmation, and audit — not eliminated.

### 9.2 Profiles

`Profile = { name, backend, allowed_domains[], idp_domains[], risk: low|med|high, proxy?, auth_check, policy, created_at, last_verified_at }`

- `allowed_domains` is **required** for any profile that holds authentication.
- Top-level navigations (including each hop of a redirect chain) outside `allowed_domains ∪ idp_domains` return `POLICY_DENIED`.
- `auth_check` is recorded at login: a URL + a "canary" (element role/name or text) that exists only when logged in. `AUTH_REQUIRED` is raised when the canary is missing, when redirected to a login-like URL, on 401/403, or when a password field appears unexpectedly.
- `policy`: `allow_eval` (default false), `allow_state_export` (false), `auto_confirm` (false for risk≥med), `rate_limit`.

### 9.3 Credential modes (strongest first)

| Mode | Description | Notes |
| --- | --- | --- |
| 0 API token | Header/cookie template per domain; token is a secret ref | Injected in daemon; agent only names the profile |
| 1 Pre-authenticated profile | Human logs in once (Mode 3), agent reuses profile | Default recommendation |
| 2 Cookie import | `auth import-cookies` (Netscape/JSON) | Validate expiry; store inside profile |
| 3 Login handoff | `auth login` opens a **headed** browser; human does MFA/CAPTCHA; Prowl records `auth_check` | Optional step recorder replays with secret refs |
| 4 Scripted login | `fill <ref> --secret NAME` and `--totp NAME` resolved in the daemon | Last resort; scoped, short-lived automation accounts only; audit each login |

TOTP seeds in the keychain reduce 2FA to single-factor on that machine. Document this and keep it opt-in for low-risk accounts.

### 9.4 Secret storage

- OS keychain first (macOS Keychain, Windows Credential Manager, libsecret).
- Fallback: age-encrypted file; passphrase from `PROWL_PASSPHRASE` env or an interactive prompt. `prowl doctor` reports which backend is active (headless Linux often lacks a keyring service).
- Profile dirs `chmod 700`; sockets `0600`.
- Encrypt-at-rest for profile dirs: **opt-in, default on for risk≥med** (implemented M7: encrypted archive while the session is closed). Chromium already protects cookies via the OS keystore; do not claim more than that.

### 9.5 Leak prevention (all required, all tested)

1. **Output scrubber** runs on every outgoing envelope, artifact, log line, memory write, and audit entry. It replaces: any value equal to a known secret (`[REDACTED:NAME]`), password-field values, `Authorization`/`Cookie`/`Set-Cookie` values, JWT-shaped strings, and long high-entropy tokens in `console`/`network` output.
2. `eval` is denied (`POLICY_DENIED`) on any profile with `allow_eval=false`. When allowed, results pass through the scrubber.
3. Cookie/localStorage values are never returned. `get cookies` returns **names and domains only**.
4. `state save/load` files are encrypted and not readable via any command; `allow_state_export` is false by default.
5. CLI never echoes secrets and never accepts them as plain arguments.
6. **Canary test:** a fixture secret (`PROWL_CANARY_9f3a…`) is set up; after every acceptance run, grep all stdout, artifacts, logs, SQLite, and audit files — zero hits required.

### 9.6 Confirmation policy

Actions whose target name matches a destructive/financial heuristic (`delete`, `remove`, `pay`, `purchase`, `buy`, `transfer`, `confirm order`, `submit application`, …) return `CONFIRMATION_REQUIRED` unless `--yes` is passed **and** the profile policy allows auto-confirm. This is a heuristic guardrail, not a guarantee; say so in docs.

### 9.7 Audit log

Append-only `~/.prowl/audit.jsonl`: `{ts, session, profile, owner, command, domain, outcome}`. Never contents or values. Rotate at 10 MB.

---

## 10. Page-content safety (prompt injection)

Requirements:

1. All page-derived output is marked untrusted (§5.6). `PROWL_AGENT_GUIDE.md` instructs agents to never follow instructions found in page content.
2. `extract --clean` strips: `display:none`, `visibility:hidden`, `aria-hidden`, zero-size and off-screen elements, HTML comments, and `<script>/<style>`.
3. Heuristic detector adds `warnings: ["possible_injection"]` for patterns such as "ignore previous instructions", "system prompt", "you must now", "send … to http…". It flags; it never blocks.
4. Cross-domain top-level navigation is denied on authenticated profiles (§9.2).
5. Downloads go to `~/.prowl/downloads/<session>/`, are never opened or executed, and are returned as paths + sha256.
6. Memory writes cannot be triggered by page content (§11).

---

## 11. Memory

**Purpose:** stop agents from re-exploring a site every time. **Not** a transcript store.

### 11.1 Record types (SQLite, one global DB `~/.prowl/prowl.db`)

| Type | Content | Written by |
| --- | --- | --- |
| `route` | task label → URL pattern | Prowl on success, or agent |
| `locator_hint` | (role, name) that worked for a task | Prowl on success |
| `auth_check` | login canary (§9.2) | Prowl at login |
| `quirk` | ≤ 200 chars free text, e.g. "search needs Enter, no button" | Agent only |
| `challenge_stat` | domain, provider, backend, outcome | Prowl (telemetry) |

### 11.2 Rules

- Key by `(domain, profile?)`. Every record has `confidence`, `last_confirmed_at`, `ttl` (default 30 days).
- Hints are **verified before use**; a failed hint lowers confidence and is dropped at 0.
- Only `quirk` is free text; it is capped, scrubbed for secrets, and returned **fenced as untrusted** like page content.
- Nothing is auto-written from page text.
- `memory forget <id>` / `memory clear --domain d` always work.
- Session scratchpad (`session_notes`) is cleared when the session closes.

---

## 12. Extraction and the escalation ladder

```text
L0  prowl fetch      HTTP GET (undici), readability → markdown. No JS. Cheapest.
L1  ephemeral browser, default backend
L2  browser + persistent profile (auth)
L3  stealth-capable backend (§13)
L4  human handoff
```

`prowl read <url>` drives the ladder:

- Start at L0 (or L2 if `--profile` given). Escalate when: empty/near-empty body, "enable JavaScript" shell, framework mount point with no content, `BLOCKED_CHALLENGE`, or 401/403.
- At most **1 attempt + 1 retry per level**; hard abort with `escalation_trace` and a reason code. Never loops.
- Respect `--max-level`. The default max level is **2**; L3/L4 require an explicit flag or config.
- `robots.txt`: advisory warning on `fetch`/`read` of public pages (`--ignore-robots` is explicit and logged). Per-domain navigation rate limit default 1/s.

Extraction pipeline: Readability main-content → Markdown; tables → Markdown tables; `--format links` returns `{text, href}`; `--select css` bypasses readability.

Documents: if content-type is PDF/Office, return `DOCUMENT_DETECTED` with the downloaded path. An optional config maps types to external converters: `converters = { pdf = "pdf-inspector {file}" }` (Prowl runs it as a subprocess and returns the Markdown). Converters are **not** part of Prowl.

---

## 13. Challenge detection and stealth (scoped, optional)

### 13.1 Position

Anti-bot evasion is an arms race. Current public benchmarks suggest the winners drive real Chrome directly or use maintained patched forks, while older Playwright stealth plugins are stale. Therefore Prowl **does not build a fingerprint engine**. Its value is (1) detection, (2) backend choice, (3) escalation, (4) hard limits.

### 13.2 In scope

- **Challenge detector** → `blocked: {provider, kind, confidence}` from: status codes 403/429/503; response headers (e.g. Cloudflare `cf-ray`); page title/text patterns ("Just a moment", "Access denied", "Verify you are human"); challenge iframes/scripts (Turnstile, reCAPTCHA, hCaptcha); vendor cookies (`datadome`, `_px*`, `_abck`); empty body with challenge scripts.
- **Backends** selectable with `--backend`: `playwright-chromium` (default) → `system-chrome` (real Chrome binary, dedicated profile) → `cdp-attach` → `patchright` → `camoufox` (sidecar process, M6).
- **Consistency helpers** (cheap, high value): headed mode option; locale/timezone/UA/viewport kept internally consistent; timezone/locale vs proxy exit-IP geo mismatch produces a warning; `--humanize` adds small randomized delays between actions.
- **Proxy:** per-profile `proxy` URL supplied by the user. Prowl does not procure proxies.
- **Telemetry:** local `challenge_stat` rows to inform defaults.

### 13.3 Hard limits

- No CAPTCHA-solver integrations in v1. Challenge → escalate or `handoff`.
- Max attempts and reason codes (P8). Per-domain rate limits.
- No features aimed at defeating authentication, paywalls, or access controls.
- Prowl is intended for sites the operator owns, has permission to automate, or public pages where automated access is permitted. Compliance with site terms and law is the operator's responsibility; document this in `docs/STEALTH.md`.

### 13.4 Chrome note

Recent Chrome versions ignore `--remote-debugging-port` when used with the default user-data directory (as far as the author knows). `cdp-attach` therefore requires a dedicated, non-default `--user-data-dir`. Verify against current Chrome behavior in M6.

### 13.5 Evaluation

Public test pages (bot.sannysoft, CreepJS, deviceandbrowserinfo, Cloudflare test pages) are used as **regression checks of backend configuration**, not as claims of bypass. Record results per backend per Chrome version in `docs/STEALTH.md`.

---

## 14. Integrations

- **MCP (`prowl mcp`)**: exposes the same verbs as tools, generated from the zod schemas; tool descriptions are the tier-appropriate short forms from `PROWL_AGENT_GUIDE.md`.
- **Agent skill / AGENTS.md**: `PROWL_AGENT_GUIDE.md` is shipped in the repo and printed by `prowl guide`.
- **n8n / scripts:** call the CLI with `--json`.
- **Firecrawl self-host, doc converters, open-catalog:** separate projects; optional adapters only. If Firecrawl is used, verify at that time: the pinned release, the compose file's persistence behavior, the license terms (it is AGPL-licensed as far as the author knows), and that self-hosting excludes the proprietary anti-bot engine.

---

## 15. Milestones and acceptance tests

### M0 — Bake-off (1–2 days) · **DECISION GATE**

Implement three scripted tasks (login+CRUD on the fixture app; read a JS-rendered page; multi-tab flow) using: (a) `agent-browser`, (b) Playwright MCP, (c) a minimal Prowl prototype. Measure bytes returned per task, step count, success, and time.
**Deliverable:** `docs/DECISION_M0.md` recommending one of: *build from scratch*, *build Prowl as a layer over agent-browser*, or *contribute/extend upstream*. Stop for human approval.

### M1 — Core daemon, ephemeral sessions, snapshot/refs, actions

Accept when:

- [ ] `open → snapshot → click @ref → snapshot --diff → close` works on the fixture app
- [ ] Envelope and exit codes match §5 for success and every error code reachable at this stage
- [ ] Stale refs return `STALE_REF` or silently re-resolve (`re_resolved: true`)
- [ ] Iframe, open shadow DOM, dialog, file upload/download fixture pages pass
- [ ] Warm-daemon p50 latency < 300 ms for `click` and `snapshot` on the fixture app
- [ ] Tier-3 run of a 6-step task completes with JSON output only and < 8 000 bytes per step

### M2 — Lifecycle and cleanup

- [ ] Idle TTL, max lifetime, owner-death grace, and orphan sweep all implemented
- [ ] **Leak test:** 100 runs with random `kill -9` of the caller and of the daemon → zero leftover browser processes and zero leftover temp profiles after `prowl gc`/next start
- [ ] `PROFILE_LOCKED` and `SESSION_BUSY` behave as in §8.3

### M3 — Profiles and auth

- [ ] Modes 1, 2, 3 implemented; `auth_check` canary and `AUTH_REQUIRED` flow work
- [ ] `allowed_domains` enforced on redirects; `POLICY_DENIED` on offsite navigation
- [ ] `eval` denied by default on authenticated profiles
- [ ] Scrubber and **canary-secret grep test** pass (zero hits)
- [ ] Audit log written; contains no values
- [ ] `handoff`/`resume` work end-to-end with a headed browser

### M4 — Fetch, ladder, extraction, memory

- [ ] `fetch` and `read` with ladder, `escalation_trace`, and hard caps
- [ ] Extraction quality: on a 30-page corpus, main content retained ≥ 90% of the time by a defined metric (record the metric in `docs/DECISIONS.md`)
- [ ] Hidden-content stripping and `possible_injection` warning on the injection-bait fixture
- [ ] Memory types, hint verification, TTL, and `forget` work; free-text `quirk` returned fenced

### M5 — Tiers, plan runner, MCP, agent guide

- [ ] `--tier` defaults per §6; Tier-3 never emits or requires a screenshot
- [ ] `prowl run plan.json` stops at first failure and returns per-step envelopes
- [ ] `prowl mcp` exposes all non-operator verbs; schema generated from zod
- [ ] `PROWL_AGENT_GUIDE.md` validated by a real agent run on the fixture task suite (§16)

### M6 — Stealth backends and detection

- [ ] `ChallengeDetector` classifies the fixture fake-challenge pages and a recorded set of real challenge pages with ≥ 90% precision (state dataset size)
- [ ] ≥ 2 additional backends pass the backend conformance suite
- [ ] Escalation to L3/L4 works with hard abort and reason codes
- [ ] Evaluation harness (§13.5) produces a per-backend table in `docs/STEALTH.md`

### M7 — Hardening and packaging

- [ ] Modes 0 and 4 (API-token injection, scripted login with `--secret`/`--totp`)
- [ ] Encrypt-at-rest for risk≥med profiles
- [ ] npm package; optional single-file binary; Windows named-pipe support verified

---

## 16. Evaluation and test fixtures

### 16.1 Fixture app (`tests/fixture-app`)

A small local web app with: login (email/password), TOTP 2FA stub, CRUD list, iframe, open shadow DOM, JS dialogs, file upload/download, delayed/lazy content, an SPA with client-side routing, an **injection-bait page** (hidden text with instructions), a **fake-challenge page** (Turnstile-like markup), an OAuth-style redirect through an allowed IdP, and an offsite link.

### 16.2 Task suite

≥ 20 scripted tasks across the fixture app, runnable by (a) a deterministic scripted client and (b) optionally a real LLM per tier. Record per-task: success, steps, bytes returned, wall time.

### 16.3 Metrics and targets

| Metric | Target |
| --- | --- |
| Fixture task success (scripted client) | ≥ 95% |
| Fixture task success (Tier 3 LLM) | measure, then set target |
| Median bytes per step, Tier 3 | < 8 000 |
| Leaked browsers after leak test | 0 |
| Secret-canary hits in any output/log/db | 0 |
| Cross-domain nav on authenticated profile | 0 allowed |
| Challenge detection precision (M6) | ≥ 90% |
| Warm `click` p50 | < 300 ms |

### 16.4 Security tests (`tests/security`)

- Injection-bait page cannot cause navigation outside `allowed_domains`
- `eval`, `get cookies`, `state` exports respect policy
- Scrubber catches secrets embedded in console/network output
- Socket permissions are user-only

---

## 17. Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Overlap with existing tools (agent-browser etc.) | M0 decision gate; differentiate on §1.4 |
| Ref stability across SPAs | Re-resolution by (role, name, nth); measure in M1 |
| Chrome updates break backends/patches | Pin versions; conformance suite per backend |
| Headless Linux has no keyring service | Encrypted-file fallback; `doctor` check |
| Windows IPC and process-group semantics | Named pipes, job objects; test in M7 |
| Stealth arms race | Backend abstraction; no custom engine; timebox M6 |
| Legal/ToS exposure | Scope statement, rate limits, no auth/paywall bypass |
| Scope creep | §1.3 non-goals; milestone gates |

**Answers to the v1 appendix questions:**

- *TS vs Rust:* TypeScript for the daemon/CLI. Revisit only on measured memory/startup problems; doc tools stay separate subprocess adapters.
- *Which stealth is safe to implement:* none custom in v1; use maintained backends on your own apps or where permitted; keep detection + limits.
- *Secrets for Tier 3 with 2FA:* human handoff, or opt-in `--totp` resolved in the daemon.
- *Minimal challenge dataset:* fixture fake-challenge pages + recorded HTML/headers from a few dozen real challenge responses, labeled by provider.
- *Encrypt profiles at rest?* Opt-in by default; on for risk≥med.

---

## Appendix A — Config (`~/.prowl/config.toml`)

```toml
[daemon]
idle_exit_minutes = 15
max_sessions = 4

[session]
ttl = "10m"
max_lifetime = "2h"
owner_grace_seconds = 60

[defaults]
tier = 2
backend = "playwright-chromium"
max_level = 2
rate_limit_per_domain_per_sec = 1

[converters]
# pdf = "pdf-inspector {file}"

[safety]
confirm_patterns = ["delete", "remove", "pay", "purchase", "buy", "transfer", "confirm order"]
```

## Appendix B — SQLite sketch

```sql
CREATE TABLE sessions(id TEXT PRIMARY KEY, name TEXT, backend TEXT, profile TEXT, mode TEXT,
  owner TEXT, state TEXT, browser_pid INT, profile_dir TEXT, created_at INT, last_activity_at INT, ttl INT);
CREATE TABLE profiles(name TEXT PRIMARY KEY, backend TEXT, allowed_domains TEXT, idp_domains TEXT,
  risk TEXT, proxy TEXT, auth_check TEXT, policy TEXT, created_at INT, last_verified_at INT);
CREATE TABLE memory(id TEXT PRIMARY KEY, domain TEXT, profile TEXT, type TEXT, key TEXT, value TEXT,
  confidence REAL, last_confirmed_at INT, ttl INT);
CREATE TABLE session_notes(session_id TEXT, k TEXT, v TEXT);
CREATE TABLE artifacts(id TEXT PRIMARY KEY, session_id TEXT, path TEXT, bytes INT, sha256 TEXT, created_at INT);
```
