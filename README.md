[![ci](https://github.com/sam-albon-li/pi-guard-git/actions/workflows/ci.yml/badge.svg)](https://github.com/sam-albon-li/pi-guard-git/actions/workflows/ci.yml)

# pi-guard-git

Prompts for explicit permission before any `git push`, showing branch, pending commits, and a diff preview.

## Install

`pi install git:github.com/sam-albon-li/pi-guard-git@v1.0.0`

Unpinned form:
`pi install git:github.com/sam-albon-li/pi-guard-git`

Note: use `pi remove git:github.com/sam-albon-li/pi-guard-git` to uninstall.

## How it works

TUI sessions get a confirm dialog with branch, upstream, pending commits, and a diff preview (truncated at 4000 chars). Declining blocks the push with reason `Git push blocked by user after review`. Headless sessions (no UI) are unaffected — the guard is a no-op.

## Development

`npm test` (zero dependencies, Node ≥ 22.19 runs TypeScript natively)

`npm run test:e2e` (drives real headless pi sessions against a local bare remote; needs a working default model)
