// mcp.ts — the Model Context Protocol surface (Streamable HTTP at /mcp, the
// 2026-07-28 protocol era). The suite discovers the server with
// `server/discover`, lists the six tools, and calls them against the same
// store the REST and GraphQL surfaces read.
//
// Replies are JSON-RPC 2.0 with the request id echoed exactly. A notification
// (no id) answers HTTP 202 with an empty body. A malformed JSON body answers
// HTTP 400 with JSON-RPC -32700. Unknown tools and missing arguments answer
// -32601 / -32602, never HTTP 500.

import { VIEWER_LOGIN } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Ctx } from './ctx.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The branch the changes are on.' },
        base: { type: 'string', description: 'The branch the changes go into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Pick owner/repo out of a tool call's arguments, tolerating the caller's synonyms. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = '';
  let repo = '';
  const fullName = args.full_name ?? args.fullName ?? args.repository_full_name;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const parts = fullName.split('/');
    owner = parts[0]!;
    repo = parts.slice(1).join('/');
  }
  if (typeof args.owner === 'string' && args.owner !== '') owner = args.owner;
  else if (typeof args.login === 'string' && args.login !== '') owner = args.login;
  const repoCandidate = args.repo ?? args.repository ?? args.name;
  if (typeof repoCandidate === 'string' && repoCandidate !== '') {
    if (repoCandidate.includes('/')) {
      const parts = repoCandidate.split('/');
      if (owner === '') owner = parts[0]!;
      repo = parts.slice(1).join('/');
    } else {
      repo = repoCandidate;
    }
  }
  if (owner === '') owner = VIEWER_LOGIN;
  if (repo === '') return null;
  return { owner, repo };
}

function stringArg(args: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function numberArg(args: Record<string, unknown>, names: string[]): number | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

type ToolResult =
  | { ok: true; data: Record<string, unknown> | { issues: unknown[] } }
  | { ok: false; code: number; message: string };

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolResult {
  const store = ctx.store;
  if (name === 'create_repo') {
    const repoName = stringArg(args, ['name', 'repo', 'repository']);
    if (repoName === '') return { ok: false, code: -32602, message: 'Missing required argument: name' };
    const description = stringArg(args, ['description']);
    const repo = store.createRepo(repoName, args.private === true, description);
    if (!repo) return { ok: false, code: -32602, message: 'Repository already exists' };
    return { ok: true, data: repoJson(repo) };
  }
  if (name === 'get_repo') {
    const target = resolveRepoArgs(args);
    if (!target) return { ok: false, code: -32602, message: 'Missing required argument: repo' };
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return { ok: false, code: -32602, message: 'Not Found' };
    return { ok: true, data: repoJson(repo) };
  }
  if (name === 'create_issue') {
    const target = resolveRepoArgs(args);
    if (!target) return { ok: false, code: -32602, message: 'Missing required argument: repo' };
    const title = stringArg(args, ['title']);
    if (title === '') return { ok: false, code: -32602, message: 'Missing required argument: title' };
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return { ok: false, code: -32602, message: 'Not Found' };
    const issue = store.createIssue(repo, title, stringArg(args, ['body']), []);
    if (issue === 'bad-label') return { ok: false, code: -32602, message: 'Invalid label' };
    return { ok: true, data: issueJson(repo, issue) };
  }
  if (name === 'list_issues') {
    const target = resolveRepoArgs(args);
    if (!target) return { ok: false, code: -32602, message: 'Missing required argument: repo' };
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return { ok: false, code: -32602, message: 'Not Found' };
    const state = stringArg(args, ['state']) || 'open';
    const issues = store.listIssues(repo, state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open', false);
    return { ok: true, data: { issues: issues.map((issue) => issueJson(repo, issue)) } };
  }
  if (name === 'create_pull_request') {
    const target = resolveRepoArgs(args);
    if (!target) return { ok: false, code: -32602, message: 'Missing required argument: repo' };
    const title = stringArg(args, ['title']);
    const head = stringArg(args, ['head', 'head_branch', 'head_ref', 'headRef']);
    const base = stringArg(args, ['base', 'base_branch', 'base_ref', 'baseRef']);
    if (title === '') return { ok: false, code: -32602, message: 'Missing required argument: title' };
    if (head === '' || base === '') return { ok: false, code: -32602, message: 'Missing required argument: head and base' };
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return { ok: false, code: -32602, message: 'Not Found' };
    const pr = store.createPull(repo, title, stringArg(args, ['body']), head, base);
    if (pr === 'bad-ref') return { ok: false, code: -32602, message: 'Invalid head or base ref' };
    if (pr === 'duplicate') return { ok: false, code: -32602, message: 'A pull request already exists for this head branch' };
    return { ok: true, data: pullJson(repo, pr) };
  }
  if (name === 'merge_pull_request') {
    const target = resolveRepoArgs(args);
    if (!target) return { ok: false, code: -32602, message: 'Missing required argument: repo' };
    const number = numberArg(args, ['pull_number', 'number', 'pullNumber', 'pull_request_number']);
    if (number === null) return { ok: false, code: -32602, message: 'Missing required argument: pull_number' };
    const repo = store.getRepo(target.owner, target.repo);
    if (!repo) return { ok: false, code: -32602, message: 'Not Found' };
    const pr = store.getPull(repo, number);
    if (!pr) return { ok: false, code: -32602, message: 'Not Found' };
    const result = store.mergePull(repo, pr);
    if (!result.ok) {
      return { ok: false, code: -32602, message: result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is not mergeable' };
    }
    return { ok: true, data: { sha: result.sha, merged: true, message: 'Pull request successfully merged' } };
  }
  return { ok: false, code: -32601, message: `Method not found: ${name}` };
}

export function handleMcp(ctx: Ctx): boolean {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method === 'DELETE') {
    ctx.send(200, '');
    return true;
  }
  if (ctx.method !== 'POST') {
    ctx.fail(405, 'Method Not Allowed');
    return true;
  }
  const extra: Record<string, string> = { 'MCP-Protocol-Version': PROTOCOL_VERSION };
  const mcpMethod = ctx.headers['mcp-method'];
  if (typeof mcpMethod === 'string') extra['Mcp-Method'] = mcpMethod;
  const mcpName = ctx.headers['mcp-name'];
  if (typeof mcpName === 'string') extra['Mcp-Name'] = mcpName;

  if (ctx.body.length > 0 && ctx.json === undefined) {
    ctx.sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, extra);
    return true;
  }
  const body = ctx.json;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    ctx.sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, extra);
    return true;
  }
  const request = body as Record<string, unknown>;
  const id = 'id' in request ? (request.id as string | number | null) : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  // A JSON-RPC notification (no id) is answered with 202 and an empty body.
  if (id === undefined) {
    ctx.send(202, '', undefined, extra);
    return true;
  }
  const params = (request.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): void => {
    ctx.sendJson(200, { jsonrpc: '2.0', id, result: value }, extra);
  };
  const error = (code: number, message: string): void => {
    ctx.sendJson(200, { jsonrpc: '2.0', id, error: { code, message } }, extra);
  };

  if (method === 'server/discover') {
    result({
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return true;
  }
  if (method === 'initialize') {
    result({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }
  if (method === 'ping') {
    result({});
    return true;
  }
  if (method === 'tools/list') {
    result({ tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === '') {
      error(-32602, 'Missing required parameter: name');
      return true;
    }
    const called = callTool(ctx, name, args);
    if (!called.ok) {
      error(called.code, called.message);
      return true;
    }
    const text = JSON.stringify(called.data);
    result({
      content: [{ type: 'text', text }],
      structuredContent: called.data,
    });
    return true;
  }
  error(-32601, `Method not found: ${method}`);
  return true;
}
