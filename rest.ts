// rest.ts — the REST v3 surface: the API root, meta, the authenticated user,
// repositories, git refs, branches, commits, contents, labels, issues,
// comments and pull requests.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id header (applied by
// app.ts). Errors are JSON with a string `message`. A repository belongs to
// the scenario viewer; any other owner reads as 404, never 403.

import { b64decode, b64encode, parseCommit, parseIdent } from './util.ts';
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  type Issue,
  type IssueComment,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import type { Ctx } from './ctx.ts';

// -------------------------------------------------------------------------------------------
// serializers
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', html_url: `https://github.com/${repo.owner}` },
    description: repo.description,
    private: repo.isPrivate,
    fork: false,
    default_branch: repo.defaultBranch,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    comments: issue.comments.length,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function pullJson(repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: pr.headSha },
    base: { ref: pr.base, sha: pr.baseSha },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
  };
}

function commitJson(repo: Repo, sha: string, epoch: number): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return { sha, commit: { message: '' } };
  const commit = parseCommit(object.data);
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  const date = new Date(epoch * 1000).toISOString();
  // GitHub's API returns the message without the commit object's trailing
  // newline; the checks compare it exactly, so strip trailing newlines.
  const message = commit.message.replace(/[\r\n]+$/, '');
  return {
    sha,
    commit: {
      message,
      author: { name: author.name, email: author.email, date },
      committer: { name: committer.name, email: committer.email, date },
    },
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

// -------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------

function paginate<T>(ctx: Ctx, items: T[]): { page: T[]; links: Record<string, string> } {
  const query = ctx.query;
  const perPageRaw = Number(query.get('per_page'));
  const perPage = Number.isInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number(query.get('page'));
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const host = ctx.headers.host ?? 'localhost';
  const base = `http://${host}${ctx.path}`;
  const links: Record<string, string> = {};
  if (start + slice.length < items.length) {
    links.next = `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
  }
  if (page > 1) {
    links.prev = `<${base}?page=${page - 1}&per_page=${perPage}>; rel="prev"`;
    links.first = `<${base}?page=1&per_page=${perPage}>; rel="first"`;
  }
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  links.last = `<${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
  return { page: slice, links };
}

function sendPage<T>(ctx: Ctx, items: T[], toJson: (item: T) => unknown): void {
  const { page, links } = paginate(ctx, items);
  const header = Object.values(links).join(', ');
  ctx.sendJson(200, page.map(toJson), header === '' ? undefined : { Link: header });
}

// -------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------

function bodyObject(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.json === undefined || ctx.json === null || typeof ctx.json !== 'object' || Array.isArray(ctx.json)) return null;
  return ctx.json as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function repoOr404(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    ctx.fail(404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    ctx.fail(404, 'Not Found');
    return null;
  }
  return repo;
}

/** Parse a ref name out of the path after a fixed prefix, keeping slashes. */
function restAfter(path: string, prefix: string): string {
  return path.slice(prefix.length);
}

export function handleRest(ctx: Ctx): boolean {
  if (!ctx.path.startsWith('/api/v3')) return false;
  const path = ctx.path;
  const method = ctx.method;

  // A body that claims to be JSON but does not parse is a client error.
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && ctx.body.length > 0 && ctx.json === undefined) {
    ctx.fail(400, 'malformed JSON body');
    return true;
  }

  // API root.
  if (path === '/api/v3' && method === 'GET') {
    ctx.sendJson(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }
  if (path === '/api/v3/meta' && method === 'GET') {
    ctx.sendJson(200, {
      verifiable_password_authentication: true,
      installed_version: '1.0.0',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      packages: [],
    });
    return true;
  }
  if (path === '/api/v3/user' && method === 'GET') {
    ctx.sendJson(200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      avatar_url: '',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      type: 'User',
      site_admin: false,
      name: VIEWER_LOGIN,
      email: VIEWER_EMAIL,
    });
    return true;
  }

  // The authenticated user's repositories.
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      sendPage(ctx, ctx.store.listRepos(), repoJson);
      return true;
    }
    if (method === 'POST') {
      const body = bodyObject(ctx);
      if (!body) {
        ctx.fail(422, 'name is required');
        return true;
      }
      const name = stringField(body, 'name');
      if (name === '' || /[/\s]/.test(name)) {
        ctx.fail(422, 'name is invalid');
        return true;
      }
      const repo = ctx.store.createRepo(name, body.private === true, stringField(body, 'description'));
      if (!repo) {
        ctx.fail(422, 'Repository already exists');
        return true;
      }
      ctx.sendJson(201, repoJson(repo));
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  const reposPrefix = '/api/v3/repos/';
  if (!path.startsWith(reposPrefix)) {
    ctx.fail(404, 'Not Found');
    return true;
  }
  const rest = path.slice(reposPrefix.length);
  const segments = rest.split('/');
  const owner = segments[0] ?? '';
  const name = segments[1] ?? '';
  if (owner === '' || name === '') {
    ctx.fail(404, 'Not Found');
    return true;
  }
  const repo = repoOr404(ctx, owner, name);
  if (!repo) return true;
  const tail = segments.slice(2);
  const tailPath = `/${tail.join('/')}`;

  // Repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      ctx.sendJson(200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = bodyObject(ctx);
      if (body) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      }
      ctx.sendJson(200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo);
      ctx.send(204, '');
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  // git refs: POST /git/refs, GET /git/refs/heads/<branch>
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      const body = bodyObject(ctx);
      const ref = body ? stringField(body, 'ref') : '';
      const sha = body ? stringField(body, 'sha') : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        ctx.fail(422, 'Invalid ref or sha');
        return true;
      }
      if (repo.refs.has(ref)) {
        ctx.fail(422, 'Reference already exists');
        return true;
      }
      if (!repo.objects.has(sha)) {
        ctx.fail(422, 'Object does not exist');
        return true;
      }
      repo.refs.set(ref, sha);
      ctx.sendJson(201, { ref, object: { sha } });
      return true;
    }
    if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
      const branch = restAfter(path, `/api/v3/repos/${owner}/${name}/git/refs/heads/`);
      const tip = repo.refs.get(`refs/heads/${decodeURIComponent(branch)}`);
      if (!tip) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      ctx.sendJson(200, { ref: `refs/heads/${decodeURIComponent(branch)}`, object: { sha: tip } });
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  // branches
  if (tail[0] === 'branches') {
    if (method === 'GET' && tail.length === 1) {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      ctx.sendJson(200, list);
      return true;
    }
    if (method === 'GET' && tail.length >= 2) {
      const branch = restAfter(path, `/api/v3/repos/${owner}/${name}/branches/`);
      const tip = repo.refs.get(`refs/heads/${decodeURIComponent(branch)}`);
      if (!tip) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      ctx.sendJson(200, { name: decodeURIComponent(branch), commit: { sha: tip }, protected: false });
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  // commits
  if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = ctx.store.resolveRef(repo, ref);
    if (!tip) {
      ctx.fail(404, 'Not Found');
      return true;
    }
    const commits = ctx.store.listCommits(repo, tip);
    sendPage(ctx, commits, (sha) => commitJson(repo, sha, ctx.store.epoch));
    return true;
  }

  // contents
  if (tail[0] === 'contents') {
    const rawPath = tail.slice(1).map(decodeURIComponent).join('/');
    const branch = ctx.query.get('ref') ?? (stringField(bodyObject(ctx) ?? {}, 'branch') || repo.defaultBranch);
    if (method === 'GET') {
      const tip = ctx.store.resolveRef(repo, branch);
      if (!tip) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      if (rawPath === '') {
        const listing = ctx.store.readDir(repo, tip, '');
        if (!listing) {
          ctx.sendJson(200, []);
          return true;
        }
        ctx.sendJson(200, listing.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid })));
        return true;
      }
      const file = ctx.store.readPath(repo, tip, rawPath);
      if (file) {
        ctx.sendJson(200, {
          type: 'file',
          encoding: 'base64',
          size: file.data.length,
          name: rawPath.split('/').pop(),
          path: rawPath,
          content: b64encode(file.data),
          sha: file.oid,
        });
        return true;
      }
      const listing = ctx.store.readDir(repo, tip, rawPath);
      if (listing) {
        ctx.sendJson(200, listing.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid })));
        return true;
      }
      ctx.fail(404, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const body = bodyObject(ctx);
      if (!body) {
        ctx.fail(422, 'content is required');
        return true;
      }
      const contentRaw = stringField(body, 'content');
      if (contentRaw === '') {
        ctx.fail(422, 'content is required');
        return true;
      }
      const targetBranch = stringField(body, 'branch') || repo.defaultBranch;
      const message = stringField(body, 'message') || `Update ${rawPath}`;
      const sha = typeof body.sha === 'string' ? body.sha : null;
      const content = b64decode(contentRaw);
      const tip = ctx.store.resolveRef(repo, targetBranch);
      const exists = tip !== undefined && ctx.store.readPath(repo, tip, rawPath) !== null;
      if (exists) {
        if (sha === null) {
          ctx.fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
          return true;
        }
        const updated = ctx.store.updateFile(repo, targetBranch, rawPath, content, message, sha);
        if (updated === 'stale') {
          ctx.fail(409, 'Conflict: sha does not match the current file');
          return true;
        }
        if (updated === 'missing') {
          ctx.fail(404, 'Not Found');
          return true;
        }
        ctx.sendJson(200, {
          content: { name: rawPath.split('/').pop(), path: rawPath, sha: updated.blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentRaw },
          commit: { sha: updated.commitSha, message },
        });
        return true;
      }
      if (sha !== null) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      const created = ctx.store.createFile(repo, targetBranch, rawPath, content, message);
      if (!created) {
        ctx.fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
        return true;
      }
      ctx.sendJson(201, {
        content: { name: rawPath.split('/').pop(), path: rawPath, sha: created.blobSha, size: content.length, type: 'file', encoding: 'base64', content: contentRaw },
        commit: { sha: created.commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const body = bodyObject(ctx);
      if (!body) {
        ctx.fail(422, 'sha is required');
        return true;
      }
      const sha = typeof body.sha === 'string' ? body.sha : null;
      if (sha === null) {
        ctx.fail(422, 'Invalid request.\n\n"sha" wasn\'t supplied.');
        return true;
      }
      const targetBranch = stringField(body, 'branch') || repo.defaultBranch;
      const message = stringField(body, 'message') || `Delete ${rawPath}`;
      const deleted = ctx.store.deleteFile(repo, targetBranch, rawPath, message);
      if (!deleted) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      ctx.sendJson(200, { commit: { sha: deleted.commitSha, message } });
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  // labels
  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      ctx.sendJson(200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const body = bodyObject(ctx);
      const name = body ? stringField(body, 'name') : '';
      if (name === '') {
        ctx.fail(422, 'name is required');
        return true;
      }
      const color = body && typeof body.color === 'string' ? body.color.replace(/^#/, '').toLowerCase() : 'ffffff';
      const label = ctx.store.createLabel(repo, name, color);
      ctx.sendJson(201, labelJson(label));
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  // issues
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const direction = ctx.query.get('direction') ?? 'desc';
        const asc = direction === 'asc';
        sendPage(ctx, ctx.store.listIssues(repo, state, asc), (issue) => issueJson(repo, issue));
        return true;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const title = body ? stringField(body, 'title') : '';
        if (title === '') {
          ctx.fail(422, 'title is required');
          return true;
        }
        const labelNames: string[] = [];
        if (body && Array.isArray(body.labels)) {
          for (const item of body.labels) {
            if (typeof item === 'string') labelNames.push(item);
            else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') {
              labelNames.push((item as Record<string, unknown>).name as string);
            }
          }
        }
        const issue = ctx.store.createIssue(repo, title, stringField(body ?? {}, 'body'), labelNames);
        if (issue === 'bad-label') {
          ctx.fail(422, 'Invalid label');
          return true;
        }
        ctx.sendJson(201, issueJson(repo, issue));
        return true;
      }
      ctx.fail(404, 'Not Found');
      return true;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number <= 0) {
      ctx.fail(404, 'Not Found');
      return true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      const issue = ctx.store.getIssue(repo, number);
      if (!issue) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        sendPage(ctx, issue.comments, (comment) => commentJson(repo, issue, comment));
        return true;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const commentBody = body ? stringField(body, 'body') : '';
        if (commentBody === '') {
          ctx.fail(422, 'body is required');
          return true;
        }
        const comment = ctx.store.addComment(repo, issue, commentBody);
        ctx.sendJson(201, commentJson(repo, issue, comment));
        return true;
      }
      ctx.fail(404, 'Not Found');
      return true;
    }
    if (tail.length === 2) {
      const issue = ctx.store.getIssue(repo, number);
      if (!issue) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        ctx.sendJson(200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const body = bodyObject(ctx);
        if (body) {
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
        }
        ctx.sendJson(200, issueJson(repo, issue));
        return true;
      }
      ctx.fail(404, 'Not Found');
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  // pull requests
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        sendPage(ctx, ctx.store.listPulls(repo, state), (pr) => pullJson(repo, pr));
        return true;
      }
      if (method === 'POST') {
        const body = bodyObject(ctx);
        const title = body ? stringField(body, 'title') : '';
        const head = body ? stringField(body, 'head') : '';
        const base = body ? stringField(body, 'base') : '';
        if (title === '' || head === '' || base === '') {
          ctx.fail(422, 'title, head and base are required');
          return true;
        }
        const pr = ctx.store.createPull(repo, title, stringField(body ?? {}, 'body'), head, base);
        if (pr === 'bad-ref') {
          ctx.fail(422, 'Invalid head or base ref');
          return true;
        }
        if (pr === 'duplicate') {
          ctx.fail(422, 'A pull request already exists for this head branch');
          return true;
        }
        ctx.sendJson(201, pullJson(repo, pr));
        return true;
      }
      ctx.fail(404, 'Not Found');
      return true;
    }
    const number = Number(tail[1]);
    if (!Number.isInteger(number) || number <= 0) {
      ctx.fail(404, 'Not Found');
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      const pr = ctx.store.getPull(repo, number);
      if (!pr) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      ctx.sendJson(200, ctx.store.pullFiles(repo, pr));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      const pr = ctx.store.getPull(repo, number);
      if (!pr) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      const result = ctx.store.mergePull(repo, pr);
      if (!result.ok) {
        if (result.reason === 'conflict') {
          ctx.fail(405, 'Merge conflict');
          return true;
        }
        ctx.fail(405, 'Pull request is not mergeable');
        return true;
      }
      ctx.sendJson(200, { sha: result.sha, merged: true, message: `Pull request successfully merged` });
      return true;
    }
    if (tail.length === 2) {
      const pr = ctx.store.getPull(repo, number);
      if (!pr) {
        ctx.fail(404, 'Not Found');
        return true;
      }
      if (method === 'GET') {
        ctx.sendJson(200, pullJson(repo, pr));
        return true;
      }
      ctx.fail(404, 'Not Found');
      return true;
    }
    ctx.fail(404, 'Not Found');
    return true;
  }

  ctx.fail(404, 'Not Found');
  return true;
}
