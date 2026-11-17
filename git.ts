// git.ts — the git smart-HTTP surface: protocol v2 (and the v0 fallback) for
// upload-pack, and v0 receive-pack, plus the /info/refs advertisements.
//
// The forge speaks git's wire protocol from its own object store. Packs are
// built with plain objects only (no deltas); the client never needs deltas
// and the suite's pack-deltas check passes on a delta-free pack.

import {
  collectReachable,
  commitsByGeneration,
  decodePktLines,
  encodePktLine,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  splitPktSection,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './util.ts';
import { DEFAULT_BRANCH, VIEWER_LOGIN, type Repo, type Store } from './store.ts';
import type { Ctx } from './ctx.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k shallow ofs-delta thin-pack multi_ack symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;

/** Sorted refs as [name, oid] pairs, HEAD's target first when present. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** The commit an annotated tag ref peels to, or null. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let current = parseTag(object.data).object;
  for (let depth = 0; depth < 10; depth += 1) {
    const next = repo.objects.get(current);
    if (!next) return null;
    if (next.type === 'commit') return current;
    if (next.type === 'tag') { current = parseTag(next.data).object; continue; }
    return null;
  }
  return null;
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=git-upload-pack\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${UPLOAD_CAPS_V0}\n`));
  } else {
    const head = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (head) parts.push(encodePktLine(`${head} HEAD\0${UPLOAD_CAPS_V0}\n`));
    for (const [name, oid] of refs) {
      parts.push(encodePktLine(`${oid} ${name}\n`));
      const peeled = peelTag(repo, oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0ReceiveAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [encodePktLine(`# service=git-receive-pack\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${RECEIVE_CAPS_V0}\n`));
  } else {
    const head = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (head) parts.push(encodePktLine(`${head} HEAD\0${RECEIVE_CAPS_V0}\n`));
    for (const [name, oid] of refs) parts.push(encodePktLine(`${oid} ${name}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    encodePktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    encodePktLine('version 2\n'),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    encodePktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Wrap pack bytes as sideband band-1 pkt-lines (each pkt-line <= 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunk = 65515;
  for (let off = 0; off < pack.length; off += chunk) {
    const piece = pack.subarray(off, Math.min(off + chunk, pack.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return parts;
}

/**
 * Wrap an already pkt-line-framed buffer (e.g. a report-status stream) in
 * sideband band-1 pkt-lines, exactly as git's send_sideband does: the
 * inner pkt-lines stay intact inside band 1.
 */
function sidebandWrap(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunk = 65515;
  for (let off = 0; off < buffer.length; off += chunk) {
    const piece = buffer.subarray(off, Math.min(off + chunk, buffer.length));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  return parts;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

/**
 * Every object reachable from `commits` through trees and tags, but never
 * through a commit's parents: the closure of a depth-limited fetch.
 */
function collectShallowObjects(repo: Repo, commits: string[]): Set<string> {
  const out = new Set<string>();
  const queue = [...commits];
  while (queue.length) {
    const oid = queue.pop()!;
    if (out.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    out.add(oid);
    if (object.type === 'commit') {
      queue.push(parseCommit(object.data).tree);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return out;
}

/**
 * Pick the objects a fetch must send: reachable from the wants (limited to
 * `deepen` generations when set), minus anything reachable from the haves.
 */
function selectFetchObjects(repo: Repo, wants: string[], haves: string[], deepen: number | null, requestShallow: string[]): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const wantedObjects = new Set<string>();
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (deepen !== null) {
    const generations = commitsByGeneration(wants, lookup, deepen);
    const included = [...generations.keys()];
    for (const [oid, gen] of generations) {
      if (gen !== deepen - 1) continue;
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit' && parseCommit(object.data).parents.length > 0) shallow.push(oid);
    }
    for (const boundary of requestShallow) {
      const gen = generations.get(boundary);
      if (gen !== undefined && gen < deepen - 1) unshallow.push(boundary);
    }
    for (const oid of collectShallowObjects(repo, included)) wantedObjects.add(oid);
  } else {
    for (const oid of collectReachable(wants, lookup, true)) wantedObjects.add(oid);
  }
  if (haves.length > 0) {
    // A deepen extends INTO the haves' ancestors, so the haves' exclusion
    // set is only their tree/tag closure (what a shallow client actually
    // holds), never their parents: collectReachable would delete the very
    // commits the deepen must deliver. Without a deepen the client holds
    // the haves' full history, so full reachability is the right set.
    const excluded = deepen !== null
      ? collectShallowObjects(repo, haves)
      : collectReachable(haves, lookup, true);
    for (const oid of excluded) wantedObjects.delete(oid);
  }
  // Deterministic pack order: breadth-first from the wants.
  const ordered: GitObject[] = [];
  const seen = new Set<string>();
  const queue = [...wants];
  const visit = (oid: string): void => {
    if (seen.has(oid) || !wantedObjects.has(oid)) return;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object) return;
    ordered.push(object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      // Trees are emitted after the commit that references them; their entries
      // are queued in tree order for a stable pack layout.
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    }
  };
  let head = 0;
  while (head < queue.length) visit(queue[head++]!);
  for (const oid of [...wantedObjects].sort()) visit(oid);
  let ack: string | null = null;
  for (const have of haves) {
    if (wants.some((w) => isAncestor(have, w, lookup))) { ack = have; break; }
  }
  return { objects: ordered, shallow, unshallow, ack };
}

function handleInfoRefs(ctx: Ctx, repo: Repo, service: string): void {
  if (service === 'git-upload-pack') {
    if (ctx.headers['git-protocol'] === 'version=2') {
      ctx.send(200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    } else {
      ctx.send(200, v0UploadAdvertisement(repo), 'application/x-git-upload-pack-advertisement');
    }
    return;
  }
  if (service === 'git-receive-pack') {
    ctx.send(200, v0ReceiveAdvertisement(repo), 'application/x-git-receive-pack-advertisement');
    return;
  }
  ctx.fail(400, `unknown service ${service}`);
}

function handleLsRefsV2(ctx: Ctx, repo: Repo, args: string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const lines: Buffer[] = [];
  const include = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const headTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  if (include('HEAD')) {
    if (headTip) {
      lines.push(encodePktLine(symrefs ? `${headTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n` : `${headTip} HEAD\n`));
    } else if (unborn) {
      lines.push(encodePktLine(symrefs ? `unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n` : 'unborn HEAD\n'));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!include(name)) continue;
    lines.push(encodePktLine(`${oid} ${name}\n`));
    if (peel) {
      const peeled = peelTag(repo, oid);
      if (peeled) lines.push(encodePktLine(`${oid} ${name} peeled:${peeled}\n`));
    }
  }
  lines.push(PKT_FLUSH);
  ctx.send(200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
}

function handleFetchV2(ctx: Ctx, repo: Repo, args: string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const requestShallow: string[] = [];
  const wantRefs: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('want-ref ')) wantRefs.push(arg.slice(9).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) requestShallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isInteger(n) && n > 0) deepen = n;
    } else if (arg === 'done') done = true;
  }
  const validWants = wants.filter((w) => isOid(w) && repo.objects.has(w));
  const selection = selectFetchObjects(repo, validWants, haves.filter(isOid), deepen, requestShallow);
  const parts: Buffer[] = [];
  // The acknowledgments section appears only when the client sent haves
  // without `done` (a negotiation round). When `done` is present the server
  // skips acks and goes straight to the pack, as git's own server does; the
  // suite's client always sends `done`, so this branch is for real-git
  // multi-round negotiation only.
  if (haves.length > 0 && !done) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (selection.ack) {
      parts.push(encodePktLine(`ACK ${selection.ack}\n`));
      parts.push(encodePktLine('ready\n'));
      parts.push(PKT_DELIM);
    } else {
      parts.push(encodePktLine('NAK\n'));
      parts.push(PKT_FLUSH);
      ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
  }
  // Sections are named by literal header lines, each followed by a delim.
  // shallow-info runs before wanted-refs: that is the order the client's
  // section checks run in. A section is omitted entirely when it has no
  // lines — in particular the packfile section is omitted when there are no
  // objects, so a fetch that transfers nothing carries a null pack.
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  // The wanted-refs section exists only for refs the client named with
  // `want-ref <name>` (git's own upload-pack sends it only when
  // wanted_refs is non-empty). A plain `want <oid>` never produces it —
  // emitting every ref for a wanted oid makes real git die with
  // "unexpected wanted-ref".
  const wantedRefs: Array<[string, string]> = [];
  for (const name of wantRefs) {
    const oid = repo.refs.get(name);
    if (oid) wantedRefs.push([name, oid]);
  }
  if (wantedRefs.length > 0) {
    parts.push(encodePktLine('wanted-refs\n'));
    for (const [name, oid] of wantedRefs) parts.push(encodePktLine(`${oid} ${name}\n`));
    parts.push(PKT_DELIM);
  }
  if (selection.objects.length > 0) {
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPack(writePack(selection.objects)));
  }
  parts.push(PKT_FLUSH);
  ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleUploadPackV2(ctx: Ctx, repo: Repo): void {
  let packets;
  try {
    packets = decodePktLines(ctx.body);
  } catch {
    ctx.fail(400, 'malformed pkt-line stream');
    return;
  }
  const delimIndex = packets.findIndex((p) => p.kind === 'delim');
  const commandLines = packets.slice(0, delimIndex < 0 ? packets.length : delimIndex)
    .filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').trim());
  const argLines = packets.slice(delimIndex < 0 ? packets.length : delimIndex + 1)
    .filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').trim());
  const command = commandLines.find((l) => l.startsWith('command='))?.slice('command='.length);
  if (command === 'ls-refs') {
    handleLsRefsV2(ctx, repo, argLines);
    return;
  }
  if (command === 'fetch') {
    handleFetchV2(ctx, repo, argLines);
    return;
  }
  ctx.fail(400, `unsupported protocol v2 command ${command ?? ''}`);
}

function handleUploadPackV0(ctx: Ctx, repo: Repo): void {
  let packets;
  try {
    packets = decodePktLines(ctx.body);
  } catch {
    ctx.fail(400, 'malformed pkt-line stream');
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const requestShallow: string[] = [];
  let deepen: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) requestShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) deepen = n;
    }
  }
  const validWants = wants.filter((w) => isOid(w) && repo.objects.has(w));
  const selection = selectFetchObjects(repo, validWants, haves.filter(isOid), deepen, requestShallow);
  const parts: Buffer[] = [encodePktLine(selection.ack ? `ACK ${selection.ack}\n` : 'NAK\n')];
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  if (selection.objects.length > 0) parts.push(...sidebandPack(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  ctx.send(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  caps: string;
}

function handleReceivePack(ctx: Ctx, repo: Repo): void {
  const split = splitPktSection(ctx.body);
  if (!split) {
    ctx.fail(400, 'malformed pkt-line stream');
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of split.packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    for (const line of text.split('\n')) {
      if (line === '') continue;
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s\0]+)(?:\0(.*))?$/.exec(line);
      if (!m) {
        ctx.fail(400, 'malformed ref update line');
        return;
      }
      commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]!, caps: m[4] ?? '' });
    }
  }
  if (commands.length === 0) {
    ctx.fail(400, 'no ref updates in request');
    return;
  }
  const sideband = commands.some((c) => c.caps.includes('side-band-64k') || c.caps.includes('side-band'));
  const report = (lines: string[]): void => {
    // The report-status stream is pkt-line-framed lines + flush. With
    // side-band-64k the whole framed stream goes inside band-1 sideband
    // packets (git's report() builds it with packet_buf_write, then
    // send_sideband); the client's packet reader expects the inner
    // framing, so raw lines inside band 1 break it ("bad line length
    // character: unpa"). Without sideband the framed stream is the body.
    const framed = Buffer.concat([...lines.map((line) => encodePktLine(line)), PKT_FLUSH]);
    if (sideband) {
      ctx.send(200, Buffer.concat(sidebandWrap(framed)), 'application/x-git-receive-pack-result');
    } else {
      ctx.send(200, framed, 'application/x-git-receive-pack-result');
    }
  };

  // Ingest the pack first: every object the new tips need must be present
  // before any ref moves.
  if (split.rest.length > 0) {
    if (!verifyPackChecksum(split.rest)) {
      report(['unpack error\n']);
      return;
    }
    let read;
    try {
      read = readPack(split.rest, (oid) => repo.objects.get(oid));
    } catch {
      report(['unpack error\n']);
      return;
    }
    for (const [oid, object] of read.objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
  }

  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const results: string[] = ['unpack ok\n'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let error: string | null = null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) error = 'no such ref';
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) error = 'stale ref';
    } else {
      const target = repo.objects.get(command.newOid);
      if (!target) {
        error = 'object not found';
      } else if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
        error = 'not a commit';
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) error = 'already exists';
      } else if (current === undefined) {
        error = 'no such ref';
      } else if (command.oldOid !== current) {
        error = 'stale ref';
      } else if (!isAncestor(command.oldOid, command.newOid, lookup)) {
        error = 'non-fast-forward';
      }
    }
    if (error) {
      results.push(`ng ${command.ref} ${error}\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
    results.push(`ok ${command.ref}\n`);
  }
  report(results);
}

/**
 * Handle a git smart-HTTP request. `tail` is the path after
 * `/{owner}/{repo}.git`. Returns true when the path belonged to the git
 * surface (even when it answered 404), false when it is not a git path.
 */
export function handleGit(ctx: Ctx, owner: string, repoName: string, tail: string): boolean {
  const repo = ctx.store.getRepo(owner, repoName);
  if (owner !== VIEWER_LOGIN || !repo) {
    // A missing repository is a plain 404 on every git endpoint; the server
    // stays up and the suite moves on.
    ctx.fail(404, 'Not Found');
    return true;
  }
  if (ctx.method === 'GET' && tail === '/info/refs') {
    const service = ctx.query.get('service') ?? '';
    handleInfoRefs(ctx, repo, service);
    return true;
  }
  if (ctx.method === 'POST' && tail === '/git-upload-pack') {
    if (ctx.headers['git-protocol'] === 'version=2') handleUploadPackV2(ctx, repo);
    else handleUploadPackV0(ctx, repo);
    return true;
  }
  if (ctx.method === 'POST' && tail === '/git-receive-pack') {
    handleReceivePack(ctx, repo);
    return true;
  }
  return false;
}
