# Tech stack

Here's the stack in the spec, plus a few things the spec leaves open that I'd suggest.

## Core stack (from the spec)

| Layer | Choice | Why |
| --- | --- | --- |
| Language / runtime | TypeScript on Node ≥ 20 | Fast iteration, npm distribution, Playwright is first-class |
| Browser control | Playwright core, behind a `BrowserBackend` interface | Mature, has accessibility snapshots, and the interface lets you swap backends later |
| Daemon ↔ CLI | JSON-RPC 2.0 over a Unix socket (named pipe on Windows), user-only permissions | No network ports, and browsers persist between short-lived CLI calls |
| Storage | `better-sqlite3`, one file at `~/.prowl/prowl.db` | Sync, reliable, no server. Holds sessions, profiles, memory, artifact index |
| Schemas | `zod`, which also generates JSON Schema | One source of truth for the CLI, the JSON envelope, and the MCP tool definitions |
| CLI parsing | `cac` or `commander` | Small and simple |
| Extraction | Mozilla Readability plus `turndown` (or `defuddle`) | Proven HTML to Markdown pipeline |
| HTTP fetch (no browser) | `undici` | Fast path for the cheapest rung of the ladder |
| Secrets | OS keychain through a maintained Node keyring binding, with an age-encrypted file fallback | Keychain first, but headless Linux often has no keyring service, so a fallback is needed |
| Config | TOML at `~/.prowl/config.toml` | Human-editable |
| Agent integration | MCP server generated from the zod schemas, plus the agent guide | Same verbs for CLI and MCP |
| Packaging | npm first, then a Node SEA or Bun single-file binary | Binary only once the CLI surface is stable |

## Browser backends (pluggable)

1. `playwright-chromium` is the default.
2. `system-chrome` uses the real Chrome binary with a dedicated profile.
3. `cdp-attach` attaches to a Chrome you launched yourself.
4. `patchright` is an optional patched Playwright fork.
5. `camoufox` is an optional Firefox-based sidecar process (M6).

Every backend has to pass the same conformance suite before it's registered.

## Suggestions the spec doesn't pin down

- **Testing:** Vitest for unit and acceptance tests, and a small Vite or Express fixture app for the login, iframe, shadow DOM, and injection-bait pages.
- **Logging:** `pino` for structured daemon logs, running through the same secret scrubber as everything else.
- **TOTP:** a small library such as `otpauth`, only needed for the opt-in `--totp` feature.
- **Encryption:** the `age` JS implementation for the encrypted-file fallback and encrypted state files.
- **Lint and types:** strict TypeScript and Biome or ESLint, which matters when coding agents are doing most of the writing.

## Deliberately not in the stack

- Rust, for now. I'd only port the daemon if you measure memory or startup problems.
- Any custom fingerprint-spoofing code.
- Firecrawl, `anydoc`, and `pdf-inspector` as dependencies. They're optional adapters, not part of the repo.

## Biggest open question

Whether this stack should exist at all. The M0 bake-off against `agent-browser` could change it. If you end up layering Prowl over that tool, the daemon and snapshot code shrinks a lot, and what's left is the auth vault, policy, the ladder, and the lifecycle supervisor.
