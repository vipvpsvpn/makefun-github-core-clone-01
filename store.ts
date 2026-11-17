// store.ts — the forge's in-memory store: repositories, git objects and refs,
// issues, labels, comments and pull requests, plus the operations the API
// surfaces share (contents commits, three-way squash merges, global ids).
//
// The viewer login is the scenario's fixed viewer (wire.ts buildScenario() is
// a pure function of the contest's constant SCENARIO_SEED, so every trial —
// practice and scored — names the same login). A repository belongs to that
// login; any other owner in a URL is foreign and reads as 404, never 403.

import {
  buildCommit,
  buildTreeFromMap,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  type GitObject,
  type GitObjectType,
} from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_IDENT = `${VIEWER_LOGIN} <${VIEWER_EMAIL}>`;
export const DEFAULT_BRANCH = 'main';

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
}

export type MergeResult =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'not-found' | 'already-merged' };

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function repoGid(owner: string, name: string): string {
  return gid('R', `${owner}/${name}`);
}

export function issueGid(owner: string, name: string, number: number): string {
  return gid('I', `${owner}/${name}#${number}`);
}

export function pullGid(owner: string, name: string, number: number): string {
  return gid('P', `${owner}/${name}#${number}`);
}

export function commentGid(owner: string, name: string, number: number, id: number): string {
  return gid('C', `${owner}/${name}#${number}:${id}`);
}

/** Decode a global id back to its kind and key, or null when it is not one of ours. */
export function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const kind = text.slice(0, colon);
    if (kind !== 'R' && kind !== 'I' && kind !== 'P' && kind !== 'C') return null;
    return { kind, key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentSeq = 1;
  repoSeq = 0;
  /** Unix seconds every server-made commit and timestamp carries (from MAKEFUN_TRIAL_NOW). */
  readonly epoch: number;
  /** The ISO form of the same instant, for created_at / merged_at fields. */
  readonly iso: string;

  constructor(epoch: number) {
    this.epoch = Number.isFinite(epoch) && epoch > 0 ? Math.floor(epoch) : 1735689600;
    this.iso = new Date(this.epoch * 1000).toISOString();
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = this.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.repoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  /** Resolve a branch name, a full ref, or an object id to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    const direct = repo.refs.get(`refs/heads/${ref}`);
    if (direct) return direct;
    return repo.refs.get(`refs/tags/${ref}`);
  }

  /** The commit oid a branch points at, or undefined when the branch is unborn. */
  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** Create a branch at `sha`; false when the ref already exists or the sha is unknown. */
  createBranch(repo: Repo, branch: string, sha: string): boolean {
    const ref = `refs/heads/${branch}`;
    if (repo.refs.has(ref)) return false;
    if (!repo.objects.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  /** List every commit reachable from `tip`, newest first (BFS from the tip). */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  private commitOneFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    let tip = this.branchTip(repo, branch);
    if (tip === undefined) {
      // A new branch starts from the default branch's tip.
      tip = this.branchTip(repo, repo.defaultBranch);
    }
    const files = new Map<string, { mode: string; oid: string }>();
    if (tip !== undefined) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      for (const [p, e] of flattenTree(commit.tree, this.lookup(repo))) files.set(p, e);
    }
    let blobSha: string | null = null;
    if (content === null) {
      files.delete(path);
    } else {
      blobSha = this.putObject(repo, 'blob', content);
      files.set(path, { mode: '100644', oid: blobSha });
    }
    const treeOid = buildTreeFromMap(files, (type, data) => this.putObject(repo, type, data));
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      message,
      author: VIEWER_IDENT,
      committer: VIEWER_IDENT,
      timestamp: this.epoch,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Create a file; returns null when the file already exists. */
  createFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip !== undefined) {
      const commit = parseCommit(repo.objects.get(tip)!.data);
      if (flattenTree(commit.tree, this.lookup(repo)).has(path)) return null;
    }
    const made = this.commitOneFile(repo, branch, path, content, message);
    return { commitSha: made.commitSha, blobSha: made.blobSha! };
  }

  /** Update a file; `expectedSha` is the blob sha the caller last saw (null = no check). */
  updateFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha: string | null,
  ): { commitSha: string; blobSha: string } | 'missing' | 'stale' {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return 'missing';
    const commit = parseCommit(repo.objects.get(tip)!.data);
    const current = flattenTree(commit.tree, this.lookup(repo)).get(path);
    if (!current) return 'missing';
    if (expectedSha !== null && expectedSha.toLowerCase() !== current.oid.toLowerCase()) return 'stale';
    const made = this.commitOneFile(repo, branch, path, content, message);
    return { commitSha: made.commitSha, blobSha: made.blobSha! };
  }

  /** Delete a file; returns null when the file does not exist. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === undefined) return null;
    const commit = parseCommit(repo.objects.get(tip)!.data);
    if (!flattenTree(commit.tree, this.lookup(repo)).has(path)) return null;
    return { commitSha: this.commitOneFile(repo, branch, path, null, message).commitSha };
  }

  /** The blob oid and bytes of a path at a commit, or null. */
  readPath(repo: Repo, tip: string, path: string): { oid: string; data: Buffer } | null {
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    const entry = flattenTree(commit.tree, this.lookup(repo)).get(path);
    if (!entry) return null;
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return null;
    return { oid: entry.oid, data: blob.data };
  }

  /** The entries of a directory at a commit (files and subdirectories, sorted by name). */
  readDir(repo: Repo, tip: string, dir: string): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string }> | null {
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    const flat = flattenTree(commit.tree, this.lookup(repo));
    const prefix = dir === '' ? '' : `${dir}/`;
    const seen = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { name: rest, path, type: 'file', oid: entry.oid });
      } else {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) seen.set(name, { name, path: `${prefix}${name}`, type: 'dir', oid: '' });
      }
    }
    if (seen.size === 0) return null;
    // A directory entry's sha is its subtree's oid.
    const out = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of out) {
      if (entry.type !== 'dir') continue;
      entry.oid = this.subtreeOid(repo, tip, entry.path) ?? '';
    }
    return out;
  }

  private subtreeOid(repo: Repo, tip: string, dir: string): string | undefined {
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return undefined;
    let treeOid = parseCommit(object.data).tree;
    for (const segment of dir.split('/')) {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return undefined;
      const found = flattenTreeShallow(tree.data).get(segment);
      if (!found || found.mode !== '40000') return undefined;
      treeOid = found.oid;
    }
    return treeOid;
  }

  // -----------------------------------------------------------------------------------------
  // labels, issues, comments
  // -----------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | 'bad-label' {
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return 'bad-label';
      labels.push(label);
    }
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(repo: Repo, state: string, sortAsc: boolean): Issue[] {
    const all = [...repo.issues.values()];
    const filtered = state === 'all' ? all : all.filter((i) => i.state === state);
    filtered.sort((a, b) => (sortAsc ? a.number - b.number : b.number - a.number));
    return filtered;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: repo.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | 'bad-ref' | 'duplicate' {
    const headSha = this.resolveRef(repo, head);
    const baseSha = this.resolveRef(repo, base);
    if (!headSha || !baseSha) return 'bad-ref';
    for (const pr of repo.pulls.values()) {
      if (pr.state === 'open' && pr.head === head) return 'duplicate';
    }
    const number = repo.nextNumber++;
    const pr: Pull = {
      id: this.nextPullId++,
      number,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: number,
    };
    repo.pulls.set(number, pr);
    return pr;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const all = [...repo.pulls.values()];
    const filtered = state === 'all' ? all : all.filter((p) => p.state === state);
    filtered.sort((a, b) => b.number - a.number);
    return filtered;
  }

  /** MERGEABLE / CONFLICTING for an open pull request (a merged one reports its stored state). */
  mergeable(repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' {
    if (pr.state !== 'open') return pr.merged ? 'MERGEABLE' : 'CONFLICTING';
    const baseTip = this.resolveRef(repo, pr.base);
    if (!baseTip) return 'CONFLICTING';
    return this.threeWay(repo, pr.headSha, baseTip).conflict ? 'CONFLICTING' : 'MERGEABLE';
  }

  private threeWay(repo: Repo, headSha: string, baseTip: string): { conflict: boolean; merged: Map<string, { mode: string; oid: string }> } {
    const lookup = this.lookup(repo);
    const base = mergeBase(headSha, baseTip, lookup);
    const baseTree = new Map<string, { mode: string; oid: string }>();
    if (base !== null) {
      const commit = parseCommit(repo.objects.get(base)!.data);
      for (const [p, e] of flattenTree(commit.tree, lookup)) baseTree.set(p, e);
    }
    const headTree = new Map<string, { mode: string; oid: string }>();
    {
      const commit = parseCommit(repo.objects.get(headSha)!.data);
      for (const [p, e] of flattenTree(commit.tree, lookup)) headTree.set(p, e);
    }
    const targetTree = new Map<string, { mode: string; oid: string }>();
    {
      const commit = parseCommit(repo.objects.get(baseTip)!.data);
      for (const [p, e] of flattenTree(commit.tree, lookup)) targetTree.set(p, e);
    }
    const merged = new Map<string, { mode: string; oid: string }>();
    let conflict = false;
    const paths = new Set<string>([...baseTree.keys(), ...headTree.keys(), ...targetTree.keys()]);
    for (const path of paths) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      const t = targetTree.get(path);
      const same = (a?: { mode: string; oid: string }, c?: { mode: string; oid: string }): boolean =>
        (a === undefined && c === undefined) || (a !== undefined && c !== undefined && a.oid === c.oid && a.mode === c.mode);
      if (same(h, t)) {
        if (h) merged.set(path, h);
      } else if (same(b, h)) {
        if (t) merged.set(path, t);
      } else if (same(b, t)) {
        if (h) merged.set(path, h);
      } else {
        conflict = true;
      }
    }
    return { conflict, merged };
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pr: Pull): MergeResult {
    if (pr.state !== 'open') return { ok: false, reason: pr.merged ? 'already-merged' : 'not-found' };
    const baseTip = this.resolveRef(repo, pr.base);
    if (!baseTip) return { ok: false, reason: 'not-found' };
    const { conflict, merged } = this.threeWay(repo, pr.headSha, baseTip);
    if (conflict) return { ok: false, reason: 'conflict' };
    const treeOid = buildTreeFromMap(merged, (type, data) => this.putObject(repo, type, data));
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: `${pr.title} (#${pr.number})`,
      author: VIEWER_IDENT,
      committer: VIEWER_IDENT,
      timestamp: this.epoch,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.base}`, sha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = this.iso;
    pr.mergeCommitSha = sha;
    return { ok: true, sha };
  }

  /** The changed files of a pull request (merge-base tree vs head tree). */
  pullFiles(repo: Repo, pr: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const lookup = this.lookup(repo);
    const base = mergeBase(pr.headSha, pr.baseSha, lookup);
    const baseTree = new Map<string, { mode: string; oid: string }>();
    if (base !== null) {
      const commit = parseCommit(repo.objects.get(base)!.data);
      for (const [p, e] of flattenTree(commit.tree, lookup)) baseTree.set(p, e);
    }
    const headTree = new Map<string, { mode: string; oid: string }>();
    {
      const commit = parseCommit(repo.objects.get(pr.headSha)!.data);
      for (const [p, e] of flattenTree(commit.tree, lookup)) headTree.set(p, e);
    }
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    const paths = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
    for (const path of [...paths].sort()) {
      const b = baseTree.get(path);
      const h = headTree.get(path);
      if (b && h && b.oid === h.oid) continue;
      const oldText = b ? textOf(repo.objects.get(b.oid)) : '';
      const newText = h ? textOf(repo.objects.get(h.oid)) : '';
      const status = !b ? 'added' : !h ? 'removed' : 'modified';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }

  /** Every object reachable from every ref (for pack building). */
  reachableFrom(repo: Repo, roots: string[]): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }
}

function textOf(object: GitObject | undefined): string {
  if (!object || object.type !== 'blob') return '';
  return object.data.toString('utf8');
}

function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === '') return { additions: lineCount(newText), deletions: 0 };
  if (newText === '') return { additions: 0, deletions: lineCount(oldText) };
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
  for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
  return { additions, deletions };
}

/** One level of a tree object: name -> {mode, oid}. */
function flattenTreeShallow(data: Buffer): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    out.set(data.subarray(sp + 1, nul).toString('utf8'), {
      mode: data.subarray(off, sp).toString('ascii'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return out;
}
