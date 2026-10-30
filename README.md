[![ci](https://github.com/sam-albon-li/pi-guard-git/actions/workflows/ci.yml/badge.svg)](https://github.com/sam-albon-li/pi-guard-git/actions/workflows/ci.yml)

# pi-guard-git

Prompts for explicit permission before `git push`, showing branch, pending commits, and a diff preview. Optional allow/deny branch rules decide which pushes skip the dialog.

## Install

`pi install git:github.com/sam-albon-li/pi-guard-git@v1.1.0`

Unpinned form:
`pi install git:github.com/sam-albon-li/pi-guard-git`

Note: use `pi remove git:github.com/sam-albon-li/pi-guard-git` to uninstall.

## How it works

TUI sessions get a confirm dialog with branch, upstream, pending commits, and a diff preview (truncated at 4000 chars). Declining blocks the push with reason `Git push blocked by user after review`. Headless sessions (no UI) are unaffected — the guard is a no-op.

## Configuration

Optional JSON config controls which branches skip the confirm dialog. Search order:

1. `PI_GUARD_GIT_CONFIG` environment variable
2. `$CWD/.pi/pi-guard-git.config.json`
3. `~/.pi/agent/pi-guard-git.config.json`

Format (both keys optional, see `pi-guard-git.example.json`):

```json
{
  "allowBranches": ["feat/*"],
  "denyBranches": ["main", "release/*"]
}
```

* `allowBranches`: pushes to matching destination branches run without a dialog
* `denyBranches`: pushes to matching branches always require confirmation (same as the default for unlisted branches)
* names are exact or `*` globs, matched against the push destination ref — `git push origin HEAD:main` targets `main`
* deny wins over allow when a branch matches both
* missing or invalid config falls back to prompt-every-push; headless sessions remain a no-op for all branches

## Development

`npm test` (zero dependencies, Node ≥ 22.19 runs TypeScript natively)

`npm run test:e2e` (drives real headless pi sessions against a local bare remote; needs a working default model)
