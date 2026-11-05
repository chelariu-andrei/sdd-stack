// Shared policy logic for the SDD stacked-PR guard (used by guard.mjs and ci-check.mjs).
// Zero dependencies: Node 18+.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function loadConfig(repoRoot) {
  const p = join(repoRoot, '.github', 'sdd-stack.json');
  if (!existsSync(p)) throw new Error(`config not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

const cache = new Map();
export function matchAny(globs = [], path) {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => {
    if (!cache.has(g)) cache.set(g, globToRegExp(g));
    return cache.get(g).test(p);
  });
}

export function isTrunk(cfg, branch) { return cfg.trunk.includes(branch); }
export function isExempt(cfg, branch) {
  return (cfg.exemptBranchPatterns || []).some((r) => new RegExp(r).test(branch));
}

/** Parse a stack branch name -> { feature, layer, type, specBranch } or null. */
export function parseBranch(cfg, name) {
  const m = new RegExp(cfg.branchPattern).exec(name || '');
  if (!m) return null;
  const { feature, layer } = m.groups;
  const type = layer === 'spec' ? 'spec' : layer.startsWith('impl-') ? 'impl' : 'tests';
  return { feature, layer, type, specBranch: `${feature}/spec` };
}

export function namingHelp(cfg) {
  return `Branch names must be <feature>/spec, <feature>/impl-<n>[-slug] or <feature>/tests-<n>[-slug] (regex: ${cfg.branchPattern}).`;
}

/** Path rules for a layer. files: [{ path }] */
export function checkLayerPaths(cfg, type, files) {
  const errors = [];
  for (const { path } of files) {
    const spec = matchAny(cfg.specPaths, path);
    const test = matchAny(cfg.testPaths, path);
    if (type === 'spec' && !spec) errors.push(`spec layer may only change spec/plan docs, but touches \`${path}\``);
    if (type === 'tests' && !test) errors.push(`tests layer may only change test files, but touches \`${path}\``);
    if (type === 'impl' && spec && !matchAny(cfg.implMayTouchSpecPaths, path))
      errors.push(`impl layer must not change the approved spec (\`${path}\`) — update the spec layer and get it re-approved`);
  }
  return errors;
}

/** Size rule. files: [{ path, additions, deletions }] */
export function checkLayerSize(cfg, type, files) {
  const max = cfg.maxChangedLines?.[type];
  if (!max) return [];
  const total = files
    .filter((f) => !matchAny(cfg.ignoreForSize, f.path))
    .reduce((s, f) => s + (f.additions || 0) + (f.deletions || 0), 0);
  return total > max
    ? [`${type} layer changes ${total} lines (limit ${max}) — split it into another layer with \`gh stack add <feature>/${type}-<n+1>-<slug>\``]
    : [];
}

export function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * Spec approval status for a feature, via the gh CLI.
 * Approved = spec PR merged, OR >= minSpecApprovals reviewers whose latest review is APPROVED
 * and nobody whose latest review is CHANGES_REQUESTED.
 */
export function specStatus(cfg, specBranch, { cwd } = {}) {
  const prs = JSON.parse(sh('gh', ['pr', 'list', '--head', specBranch, '--state', 'all',
    '--json', 'number,state,url,headRefName', '--limit', '5'], { cwd }) || '[]')
    .filter((p) => p.headRefName === specBranch);
  const pr = prs.find((p) => p.state === 'MERGED') || prs.find((p) => p.state === 'OPEN');
  if (!pr) return { approved: false, reason: `no PR exists for \`${specBranch}\` — submit the spec layer first (\`gh stack submit\`)` };
  if (pr.state === 'MERGED') return { approved: true, pr };

  const pages = JSON.parse(sh('gh', ['api', '--paginate', '--slurp',
    `repos/{owner}/{repo}/pulls/${pr.number}/reviews`], { cwd }) || '[]');
  const latest = new Map();
  for (const r of pages.flat()) {
    if (!r.user || !['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    latest.set(r.user.login, r.state);
  }
  const states = [...latest.values()];
  const approvals = states.filter((s) => s === 'APPROVED').length;
  if (states.includes('CHANGES_REQUESTED'))
    return { approved: false, pr, reason: `spec PR #${pr.number} has changes requested` };
  if (approvals < (cfg.minSpecApprovals ?? 1))
    return { approved: false, pr, reason: `spec PR #${pr.number} has ${approvals}/${cfg.minSpecApprovals ?? 1} approvals (${pr.url})` };
  return { approved: true, pr };
}
