# GitHub Core Clone — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vipvpsvpn/makefun-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vipvpsvpn/makefun-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

One Node process, its own store, no UI, no outside service, no git binary:
a GitHub-compatible forge speaking smart-HTTP clone/push, the REST v3 API,
GraphQL, and MCP tools.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: protocol v2 upload-pack
  (`ls-refs`, `fetch` with shallow/deepen, thin-pack) with a v0 fallback,
  and v0 receive-pack with `report-status` and `side-band-64k`. Packs are
  built and read from scratch (plain objects, OFS/REF delta resolution on
  read), with fast-forward enforcement per ref.
- **REST v3** at `/api/v3`: repositories, git refs, branches, commits,
  contents (create/update/delete with sha checks), labels, issues,
  comments, and pull requests with a real three-way squash merge.
- **GraphQL** at `/api/graphql`: a small real parser and executor for the
  queries and mutations `gh` and `github-mcp-server` send, including
  introspection of `__type`, cursor pagination, and opaque global ids.
- **MCP** at `/mcp`: Streamable HTTP, protocol version `2026-07-28`
  (`server/discover`, `tools/list`, `tools/call`) with six tools —
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — over the same store.

## Run it

Node 22 or newer, standard library only, nothing to install:

```sh
node main.ts
```

In a trial the environment sets `MAKEFUN_ENV_URL`, `MAKEFUN_SHOP_TOKEN`
and `MAKEFUN_TRIAL_NOW`; the program binds an ephemeral port, registers
it, and polls `/done` until the trial ends. Without `MAKEFUN_ENV_URL` it
listens on `$PORT` (default 18080) for local testing, with no auth.

Determinism: every server-made commit and timestamp uses
`MAKEFUN_TRIAL_NOW`, request ids come from a counter, and there is no
wall clock or unseeded randomness anywhere, so a trial and its replay
export identical state.

## Layout

- `main.ts` — the entry/env lifecycle (register, poll `/done`, exit 0)
- `app.ts` — the HTTP server, routing, auth, request ids
- `util.ts` — SHA-1 object ids, pkt-lines, pack read/write, trees/commits/tags, reachability
- `store.ts` — repositories, objects, refs, issues, pull requests, merges
- `git.ts` — smart-HTTP protocol v2/v0 and receive-pack
- `rest.ts` — the REST v3 API
- `graphql.ts` — the GraphQL parser and executor
- `mcp.ts` — the MCP server and tools

---

Entered on [make.fun](https://make.fun/?ref=3b7861zt&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
