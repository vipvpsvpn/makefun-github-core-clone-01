// graphql.ts — a small, real GraphQL parser and executor for the subset gh and
// github-mcp-server send: operations with variables and aliases, inline
// fragments, introspection of __type, and the create/close/merge mutations.
//
// Unknown fields return HTTP 200 with an errors array naming the field (and a
// null data), exactly the way GitHub's API answers. An unknown repository
// resolves to data.repository = null with no errors. Global ids are opaque
// base64 values (never the numeric database id).

import {
  commentGid,
  decodeGid,
  issueGid,
  pullGid,
  repoGid,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type IssueComment,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import type { Ctx } from './ctx.ts';

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string): boolean => /[0-9]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(j + 2, j + 6))) {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else if (esc !== undefined) out += esc;
          j += 2;
          continue;
        }
        out += input[j];
        j += 1;
      }
      if (j >= input.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || isDigit(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && isDigit(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && isDigit(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && isDigit(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selection: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selection: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefaults: Record<string, ValueNode>;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Record<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind} ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind} ${token.value}`);
    if (value !== undefined && token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, SelectionNode[]> = {};
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          name: null,
          variableDefaults: {},
          selection: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = this.next().value as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        if (this.peek()?.kind === 'name') name = this.next().value;
        const variableDefaults: Record<string, ValueNode> = {};
        if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
          this.expectPunct('(');
          while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.peek()?.kind === 'punct' && this.peek()!.value === '=') {
              this.expectPunct('=');
              variableDefaults[varName] = this.parseValue();
            }
            if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
          }
          this.expectPunct(')');
        }
        operations.push({ operation, name, variableDefaults, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      throw new Error(`unexpected token ${token.kind} ${token.value}`);
    }
    if (operations.length === 0) throw new Error('no operation in document');
    return { operations, fragments };
  }

  private parseType(): void {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.expectPunct('[');
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        return { kind: 'spread', name };
      }
      if (next?.kind === 'punct' && next.value === '{') {
        return { kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() };
      }
      throw new Error('malformed fragment');
    }
    if (token.kind !== 'name') throw new Error(`expected a field name, got ${token.kind} ${token.value}`);
    const first = this.next().value;
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.expectPunct('(');
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args[argName] = this.parseValue();
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    // Directives (@include, @skip) are parsed and ignored.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
        this.expectPunct('(');
        while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
          if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
        }
        this.expectPunct(')');
      }
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === ']')) {
        items.push(this.parseValue());
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()!.value === '}')) {
        const key = this.expectName();
        this.expectPunct(':');
        fields[key] = this.parseValue();
        if (this.peek()?.kind === 'punct' && this.peek()!.value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.kind} ${token.value}`);
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

type AnyNode = Record<string, unknown> & { __typename: string };

interface GqlContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Record<string, SelectionNode[]>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'int': case 'float': case 'string': case 'boolean': case 'enum': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function repoNode(repo: Repo): AnyNode {
  return { __typename: 'Repository', repo };
}

function issueNode(repo: Repo, issue: Issue): AnyNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pr: Pull): AnyNode {
  return { __typename: 'PullRequest', repo, pr };
}

function userNode(login: string): AnyNode {
  return { __typename: 'User', login };
}

function commentNode(repo: Repo, issue: Issue, comment: IssueComment): AnyNode {
  return { __typename: 'IssueComment', repo, issue, comment };
}

function pageInfoNode(hasNextPage: boolean, endCursor: string | null): AnyNode {
  return { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: null };
}

function connectionNode(typename: string, nodes: AnyNode[], hasNextPage: boolean, endCursor: string | null, totalCount: number): AnyNode {
  return { __typename: typename, nodes, pageInfo: pageInfoNode(hasNextPage, endCursor), totalCount };
}

function paginateNumbers<T>(items: T[], numberOf: (item: T, index: number) => number, args: Record<string, unknown>, descending: boolean): { nodes: T[]; hasNextPage: boolean; endCursor: string | null; totalCount: number } {
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : null;
  const after = cursorNumber(args.after);
  const keyed = items.map((item, index) => ({ item, key: numberOf(item, index) }));
  let filtered = keyed;
  if (after !== null) {
    filtered = keyed.filter((entry) => (descending ? entry.key < after : entry.key > after));
  }
  const totalCount = filtered.length;
  const page = first === null ? filtered : filtered.slice(0, first);
  const hasNextPage = first !== null && filtered.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.key) : null;
  return { nodes: page.map((entry) => entry.item), hasNextPage, endCursor, totalCount };
}

const TYPE_INFO: Record<string, { kind: string; fields?: string[]; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge'] },
  User: { kind: 'OBJECT', fields: ['login', 'id'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  SearchType: { kind: 'ENUM', enumValues: ['DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

function typeNode(name: string): AnyNode | null {
  const info = TYPE_INFO[name];
  if (!info) return null;
  return { __typename: '__Type', typeName: name, kind: info.kind, fields: info.fields ?? [], enumValues: info.enumValues ?? [] };
}

type Resolver = (node: AnyNode, args: Record<string, unknown>, ctx: GqlContext) => unknown;

function issuesConnection(repo: Repo, args: Record<string, unknown>): AnyNode {
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((s) => (s === 'CLOSED' ? 'closed' : 'open')));
  const all = [...repo.issues.values()].filter((issue) => wanted.has(issue.state));
  all.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const page = paginateNumbers(all, (issue) => issue.number, args, direction === 'DESC');
  return connectionNode('IssueConnection', page.nodes.map((issue) => issueNode(repo, issue)), page.hasNextPage, page.endCursor, page.totalCount);
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): AnyNode {
  const all = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const page = paginateNumbers(all, (pr) => pr.number, args, true);
  return connectionNode('PullRequestConnection', page.nodes.map((pr) => pullNode(repo, pr)), page.hasNextPage, page.endCursor, page.totalCount);
}

function filesConnection(store: Store, repo: Repo, pr: Pull, args: Record<string, unknown>): AnyNode {
  const files = store.pullFiles(repo, pr);
  const page = paginateNumbers(files, (_file, index) => index, args, false);
  return connectionNode(
    'PullRequestChangedFileConnection',
    page.nodes.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }) as AnyNode),
    page.hasNextPage,
    page.endCursor,
    page.totalCount,
  );
}

function nodeFromGid(store: Store, id: unknown): AnyNode | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGid(id);
  if (!decoded) return null;
  if (decoded.kind === 'R') {
    const [owner, name] = decoded.key.split('/');
    if (!owner || !name) return null;
    const repo = store.getRepo(owner, name);
    return repo ? repoNode(repo) : null;
  }
  if (decoded.kind === 'I') {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!m) return null;
    const repo = store.getRepo(m[1]!, m[2]!);
    const issue = repo?.issues.get(Number(m[3]));
    return repo && issue ? issueNode(repo, issue) : null;
  }
  if (decoded.kind === 'P') {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(decoded.key);
    if (!m) return null;
    const repo = store.getRepo(m[1]!, m[2]!);
    const pr = repo?.pulls.get(Number(m[3]));
    return repo && pr ? pullNode(repo, pr) : null;
  }
  return null;
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(VIEWER_LOGIN),
    repository: (node, args, ctx) => {
      const owner = args.owner;
      const name = args.name;
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repoNode(repo) : null;
    },
    node: (node, args, ctx) => nodeFromGid(ctx.store, args.id),
    __type: (node, args) => (typeof args.name === 'string' ? typeNode(args.name) : null),
  },
  Mutation: {
    createIssue: (node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = nodeFromGid(ctx.store, input.repositoryId);
      if (!repo || repo.__typename !== 'Repository') throw new Error('Repository not found');
      const repoObj = repo.repo as Repo;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = ctx.store.createIssue(repoObj, title, body, []);
      if (issue === 'bad-label') throw new Error('Invalid label');
      return { __typename: 'CreateIssuePayload', issue: issueNode(repoObj, issue) };
    },
    closeIssue: (node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = nodeFromGid(ctx.store, input.issueId);
      if (!target || target.__typename !== 'Issue') throw new Error('Issue not found');
      const issue = target.issue as Issue;
      issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', issue: target };
    },
    createPullRequest: (node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = nodeFromGid(ctx.store, input.repositoryId);
      if (!repo || repo.__typename !== 'Repository') throw new Error('Repository not found');
      const repoObj = repo.repo as Repo;
      const pr = ctx.store.createPull(
        repoObj,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : '',
      );
      if (pr === 'bad-ref') throw new Error('Invalid head or base ref');
      if (pr === 'duplicate') throw new Error('A pull request already exists for this head branch');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repoObj, pr) };
    },
    mergePullRequest: (node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = nodeFromGid(ctx.store, input.pullRequestId);
      if (!target || target.__typename !== 'PullRequest') throw new Error('Pull request not found');
      const repoObj = target.repo as Repo;
      const pr = target.pr as Pull;
      const result = ctx.store.mergePull(repoObj, pr);
      if (!result.ok) throw new Error(result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(repoObj, pr) };
    },
    addComment: (node, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const target = nodeFromGid(ctx.store, input.subjectId);
      if (!target || target.__typename !== 'Issue') throw new Error('Subject not found');
      const repoObj = target.repo as Repo;
      const issue = target.issue as Issue;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = ctx.store.addComment(repoObj, issue, body);
      const commentId = commentGid(repoObj.owner, repoObj.name, issue.number, comment.id);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node: { __typename: 'IssueComment', repo: repoObj, issue, comment, id: commentId } as AnyNode },
      };
    },
  },
  Repository: {
    id: (node) => repoGid((node.repo as Repo).owner, (node.repo as Repo).name),
    databaseId: (node) => (node.repo as Repo).id,
    name: (node) => (node.repo as Repo).name,
    nameWithOwner: (node) => `${(node.repo as Repo).owner}/${(node.repo as Repo).name}`,
    owner: (node) => userNode((node.repo as Repo).owner),
    defaultBranchRef: (node) => {
      const repo = node.repo as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (node, args) => {
      const repo = node.repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (node, args) => issuesConnection(node.repo as Repo, args),
    pullRequests: (node, args) => pullsConnection(node.repo as Repo, args),
    pullRequest: (node, args) => {
      const repo = node.repo as Repo;
      const number = args.number;
      if (typeof number !== 'number') return null;
      const pr = repo.pulls.get(number);
      return pr ? pullNode(repo, pr) : null;
    },
  },
  Issue: {
    id: (node) => issueGid((node.repo as Repo).owner, (node.repo as Repo).name, (node.issue as Issue).number),
    number: (node) => (node.issue as Issue).number,
    title: (node) => (node.issue as Issue).title,
    state: (node) => ((node.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (node) => (node.issue as Issue).body,
  },
  IssueConnection: {
    nodes: (node) => node.nodes as AnyNode[],
    pageInfo: (node) => node.pageInfo as AnyNode,
    totalCount: (node) => node.totalCount as number,
  },
  IssueComment: {
    id: (node) => (node.id as string | undefined) ?? commentGid((node.repo as Repo).owner, (node.repo as Repo).name, (node.issue as Issue).number, (node.comment as IssueComment).id),
    body: (node) => (node.comment as IssueComment).body,
  },
  IssueCommentEdge: {
    node: (node) => node.node as AnyNode,
  },
  PageInfo: {
    hasNextPage: (node) => node.hasNextPage as boolean,
    endCursor: (node) => node.endCursor as string | null,
    hasPreviousPage: (node) => node.hasPreviousPage as boolean,
    startCursor: (node) => node.startCursor as string | null,
  },
  PullRequest: {
    id: (node) => pullGid((node.repo as Repo).owner, (node.repo as Repo).name, (node.pr as Pull).number),
    number: (node) => (node.pr as Pull).number,
    state: (node) => {
      const pr = node.pr as Pull;
      if (pr.merged) return 'MERGED';
      return pr.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (node) => (node.pr as Pull).merged,
    headRefName: (node) => (node.pr as Pull).head,
    baseRefName: (node) => (node.pr as Pull).base,
    mergeable: (node, args, ctx) => ctx.store.mergeable(node.repo as Repo, node.pr as Pull),
    files: (node, args, ctx) => filesConnection(ctx.store, node.repo as Repo, node.pr as Pull, args),
  },
  PullRequestConnection: {
    nodes: (node) => node.nodes as AnyNode[],
    pageInfo: (node) => node.pageInfo as AnyNode,
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestChangedFileConnection: {
    nodes: (node) => node.nodes as AnyNode[],
    pageInfo: (node) => node.pageInfo as AnyNode,
    totalCount: (node) => node.totalCount as number,
  },
  PullRequestChangedFile: {
    path: (node) => node.path as string,
  },
  CreateIssuePayload: {
    issue: (node) => node.issue as AnyNode,
  },
  CloseIssuePayload: {
    issue: (node) => node.issue as AnyNode,
  },
  CreatePullRequestPayload: {
    pullRequest: (node) => node.pullRequest as AnyNode,
  },
  MergePullRequestPayload: {
    pullRequest: (node) => node.pullRequest as AnyNode,
  },
  AddCommentPayload: {
    commentEdge: (node) => node.commentEdge as AnyNode,
  },
  User: {
    login: (node) => node.login as string,
    id: () => VIEWER_ID,
  },
  Ref: {
    name: (node) => node.name as string,
  },
  __Type: {
    name: (node) => node.typeName as string,
    kind: (node) => node.kind as string,
    description: () => null,
    fields: (node) => ((node.fields as string[]) ?? []).map((name) => ({ __typename: '__Field', name }) as AnyNode),
    enumValues: (node) => ((node.enumValues as string[]) ?? []).map((name) => ({ __typename: '__EnumValue', name }) as AnyNode),
  },
  __Field: {
    name: (node) => node.name as string,
    description: () => null,
    type: () => ({ __typename: '__Type', typeName: 'String', kind: 'SCALAR', fields: [], enumValues: [] }) as AnyNode,
  },
  __EnumValue: {
    name: (node) => node.name as string,
    description: () => null,
  },
};

function resolveSelection(node: AnyNode, selection: SelectionNode[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of selection) {
    if (item.kind === 'spread') {
      const fragment = ctx.fragments[item.name];
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${item.name}"` });
        continue;
      }
      Object.assign(out, resolveSelection(node, fragment, ctx));
      continue;
    }
    if (item.kind === 'inline') {
      if (item.typeCondition && item.typeCondition !== node.__typename) continue;
      Object.assign(out, resolveSelection(node, item.selection, ctx));
      continue;
    }
    const key = item.alias ?? item.name;
    if (item.name === '__typename') {
      out[key] = node.__typename;
      continue;
    }
    const typeResolvers = RESOLVERS[node.__typename];
    const resolver = typeResolvers?.[item.name];
    if (!resolver) {
      ctx.errors.push({ message: `Cannot query field "${item.name}" on type "${node.__typename}"` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(item.args)) args[name] = resolveValue(value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(node, args, ctx);
    } catch (err) {
      ctx.errors.push({ message: (err as Error).message });
      continue;
    }
    out[key] = completeValue(value, item.selection, ctx);
  }
  return out;
}

function completeValue(value: unknown, selection: SelectionNode[] | null, ctx: GqlContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, selection, ctx));
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    if (!selection) return value;
    return resolveSelection(value as AnyNode, selection, ctx);
  }
  return value;
}

function executeDocument(store: Store, doc: DocumentNode, variables: Record<string, unknown>, operationName: string | null): { data: unknown; errors?: Array<{ message: string }> } {
  const operation = operationName
    ? doc.operations.find((op) => op.name === operationName)
    : doc.operations[0];
  if (!operation) return { data: null, errors: [{ message: `Unknown operation ${operationName ?? ''}` }] };
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, defaultValue] of Object.entries(operation.variableDefaults)) {
    if (mergedVariables[name] === undefined) mergedVariables[name] = resolveValue(defaultValue, {});
  }
  const ctx: GqlContext = { store, variables: mergedVariables, errors: [], fragments: doc.fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyNode = { __typename: rootType };
  const data = resolveSelection(root, operation.selection, ctx);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data };
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>, operationName: string | null): { data: unknown; errors?: Array<{ message: string }> } {
  let doc: DocumentNode;
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  return executeDocument(store, doc, variables, operationName);
}

export function handleGraphql(ctx: Ctx): boolean {
  if (ctx.path !== '/api/graphql') return false;
  if (ctx.method !== 'POST') {
    ctx.fail(404, 'Not Found');
    return true;
  }
  if (ctx.body.length > 0 && ctx.json === undefined) {
    ctx.fail(400, 'malformed JSON body');
    return true;
  }
  const body = ctx.json;
  if (Array.isArray(body)) {
    const results = body.map((item) => runOne(ctx, item));
    ctx.sendJson(200, results);
    return true;
  }
  ctx.sendJson(200, runOne(ctx, body));
  return true;
}

function runOne(ctx: Ctx, item: unknown): { data: unknown; errors?: Array<{ message: string }> } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { data: null, errors: [{ message: 'Request body must be a GraphQL operation object' }] };
  }
  const record = item as Record<string, unknown>;
  const query = record.query;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'Request body must include a query string' }] };
  }
  const variables = (record.variables ?? {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  return executeGraphQL(ctx.store, query, variables, operationName);
}
