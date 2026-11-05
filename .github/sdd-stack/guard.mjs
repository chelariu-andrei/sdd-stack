#!/usr/bin/env node
// Copilot preToolUse hook: enforces the SDD stacked-PR workflow for the AGENT.
// Reads the hook payload on stdin (camelCase CLI format or VS Code/Claude PascalCase format).
// Deny = JSON on stdout + reason on stderr + exit 2 (understood by Copilot CLI, cloud agent and VS Code).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadConfig, parseBranch, isTrunk, isExempt, namingHelp, matchAny,
  checkLayerPaths, checkLayerSize, specStatus, sh,
} from './lib.mjs';

function deny(reason) {
  const msg = `[sdd-stack] ${reason}`;
  process.stdout.write(JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: msg,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: msg },
  }));
  process.stderr.write(msg + '\n');
  process.exit(2);
}
const allow = () => process.exit(0);

let payload;
try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { allow(); }

const toolName = String(payload.toolName ?? payload.tool_name ?? '');
let args = payload.toolArgs ?? payload.tool_input ?? {};
if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { command: args }; } }
const cwd = payload.cwd || process.cwd();

let root;
try { root = sh('git', ['rev-parse', '--show-toplevel'], { cwd }); } catch { allow(); } // not a git repo
let cfg;
try { cfg = loadConfig(root); } catch { allow(); } // repo doesn't use the policy

const git = (...a) => { try { return sh('git', a, { cwd: root }); } catch { return ''; } };
const currentBranch = () => git('branch', '--show-current');

// ---------- spec approval (cached only when approved) ----------
const cacheFile = join(root, '.git', 'sdd-stack-approvals.json');
function specApproved(specBranch) {
  let c = {};
  try { if (existsSync(cacheFile)) c = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch {}
  const ttl = (cfg.agent?.approvalCacheSeconds ?? 600) * 1000;
  if (c[specBranch] && Date.now() - c[specBranch] < ttl) return { approved: true };
  let st;
  try { st = specStatus(cfg, specBranch, { cwd: root }); }
  catch (e) { return { approved: false, reason: `could not verify spec approval via gh (${String(e.message).split('\n')[0]}) — is \`gh\` installed and authenticated?` }; }
  if (st.approved) { c[specBranch] = Date.now(); try { writeFileSync(cacheFile, JSON.stringify(c)); } catch {} }
  return st;
}
function requireSpecApproved(info, action) {
  if (info.type === 'spec') return;
  const st = specApproved(info.specBranch);
  if (!st.approved)
    deny(`${action} is blocked: implementation/test work for \`${info.feature}\` starts only after the spec PR is approved. ${st.reason || ''} Stop here and ask the team to review the spec PR.`);
}

// ---------- layer diff of a local branch (excludes trunk + ancestor layers) ----------
function layerFiles(branch, info) {
  const others = git('for-each-ref', '--format=%(refname:short)', `refs/heads/${info.feature}/`)
    .split('\n').filter((b) => b && b !== branch)
    // keep layers below us (incl. same commit, e.g. a fresh empty layer) or beside us; drop layers stacked strictly on top
    .filter((b) => isAncestor(b, branch) || !isAncestor(branch, b));
  const excl = [...cfg.trunk.flatMap((t) => [t, `origin/${t}`]), ...others]
    .filter((r) => git('rev-parse', '--verify', '--quiet', r));
  const out = git('log', '--numstat', '--format=', branch, '--not', ...excl);
  const map = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, path] = line.split('\t');
    const f = map.get(path) || { path, additions: 0, deletions: 0 };
    f.additions += Number(a) || 0; f.deletions += Number(d) || 0; map.set(path, f);
  }
  return [...map.values()];
}
function isAncestor(a, b) {
  try { sh('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }); return true; } catch { return false; }
}
function stagedFiles(includeUnstaged) {
  const parse = (out) => out.split('\n').filter(Boolean).map((l) => {
    const [a, d, path] = l.split('\t'); return { path, additions: Number(a) || 0, deletions: Number(d) || 0 };
  });
  const files = parse(git('diff', '--cached', '--numstat'));
  if (includeUnstaged) files.push(...parse(git('diff', '--numstat')));
  return files;
}

// ---------- shell command rules ----------
function tokenize(seg) {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}
function positionalAfter(tokens, idx) {
  for (let i = idx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) { if (/^--?(base|b|message|m)$/.test(t)) i++; continue; }
    return t;
  }
  return null;
}

function checkSegment(seg) {
  const t = tokenize(seg);
  // strip env assignments / wrappers like `GH_PAGER= gh ...`
  while (t.length && /^[A-Z_]+=/.test(t[0])) t.shift();
  const [bin, sub, sub2] = t;
  // follow `git checkout X && ...` / `git switch X && ...` inside one command line
  if (bin === 'git' && ['checkout', 'switch'].includes(sub) && t.length === 3 && !t[2].startsWith('-')) simulatedBranch = t[2];
  const branch = simulatedBranch ?? currentBranch();
  const info = parseBranch(cfg, branch);

  if (bin === 'git' && sub === 'push') {
    if (t.includes('--force') || t.includes('-f'))
      deny('plain `--force` is not allowed; use `gh stack push` (it uses --force-with-lease) or `git push --force-with-lease`.');
    const refspecs = t.slice(2).filter((x) => !x.startsWith('-')).slice(1);
    const targets = refspecs.map((r) => r.split(':').pop().replace(/^refs\/heads\//, '').replace(/^\+/, ''));
    if (targets.some((x) => isTrunk(cfg, x)) || (refspecs.length === 0 && isTrunk(cfg, branch)))
      deny(`pushing to ${cfg.trunk.join('/')} is not allowed. Work goes through a PR stack: \`gh stack init\` (spec layer) → review → \`gh stack add\`.`);
    if (info) requireSpecApproved(info, `\`git push\` of \`${branch}\``);
  }

  if (bin === 'git' && sub === 'commit') {
    if (isTrunk(cfg, branch))
      deny(`committing on \`${branch}\` is not allowed. Start a stack with the spec layer: \`gh stack init\` and name it \`<feature>/spec\`.`);
    if (info) {
      requireSpecApproved(info, `committing on \`${branch}\``);
      const staged = stagedFiles(t.some((x) => x === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(x)));
      const errs = [...checkLayerPaths(cfg, info.type, staged),
        ...checkLayerSize(cfg, info.type, [...layerFiles(branch, info), ...staged])];
      if (errs.length) deny(`commit rejected for layer \`${branch}\`:\n- ${errs.join('\n- ')}`);
    } else if (!isExempt(cfg, branch)) {
      deny(`branch \`${branch}\` is not a stack layer. ${namingHelp(cfg)} If this is a superpowers worktree branch, rename it: \`git branch -m ${branch} <feature>/spec\` (or the right layer).`);
    }
  }

  // superpowers finishing-a-development-branch "merge back locally" option
  if (bin === 'git' && sub === 'merge' && isTrunk(cfg, branch) && !t.includes('--abort'))
    deny(`merging into \`${branch}\` locally is not allowed. Finish with \`gh stack submit\`; the team merges the stack on GitHub.`);

  if (bin === 'git' && (['checkout', 'switch'].includes(sub) && t.some((x) => ['-b', '-B', '-c', '-C'].includes(x)))) {
    const name = t[t.findIndex((x) => ['-b', '-B', '-c', '-C'].includes(x)) + 1];
    const ni = parseBranch(cfg, name);
    if (ni) requireSpecApproved(ni, `creating \`${name}\``);
  }

  if (bin === 'gh' && sub === 'pr') {
    if (sub2 === 'create' && cfg.agent?.blockPlainPrCreate)
      deny('do not open PRs with `gh pr create`. Use `gh stack submit` so every layer is a linked stacked PR.');
    if (sub2 === 'merge' && cfg.agent?.blockMerge)
      deny('the agent must not merge PRs. Humans merge the stack from the bottom up after review.');
    if (sub2 === 'review' && cfg.agent?.blockSelfApprove && t.includes('--approve'))
      deny('the agent must not approve PRs. Spec and implementation approvals come from the team.');
  }

  if (bin === 'gh' && sub === 'stack') {
    if (sub2 === 'merge' && cfg.agent?.blockMerge) deny('the agent must not merge stacks.');
    if (sub2 === 'init' || sub2 === 'add') {
      const name = positionalAfter(t, 3);
      if (name) {
        const ni = parseBranch(cfg, name);
        if (!ni) deny(`invalid layer name \`${name}\`. ${namingHelp(cfg)}`);
        if (sub2 === 'init' && ni.type !== 'spec') deny(`a stack must start with the spec layer: \`gh stack init ${ni.feature}/spec\`.`);
        requireSpecApproved(ni, `\`gh stack ${sub2} ${name}\``);
      } else if (sub2 === 'add' && info) {
        requireSpecApproved({ ...info, type: 'impl' }, '`gh stack add`');
      }
    }
    if (sub2 === 'push' || sub2 === 'submit') {
      if (!info) { if (!isExempt(cfg, branch)) deny(`current branch \`${branch}\` is not a stack layer. ${namingHelp(cfg)}`); return; }
      const layers = git('for-each-ref', '--format=%(refname:short)', `refs/heads/${info.feature}/`).split('\n').filter(Boolean);
      const errs = [];
      for (const b of layers) {
        const bi = parseBranch(cfg, b);
        if (!bi) { errs.push(`\`${b}\`: ${namingHelp(cfg)}`); continue; }
        const files = layerFiles(b, bi);
        errs.push(...[...checkLayerPaths(cfg, bi.type, files), ...checkLayerSize(cfg, bi.type, files)].map((e) => `\`${b}\`: ${e}`));
      }
      if (!layers.includes(info.specBranch)) errs.push(`missing spec layer \`${info.specBranch}\` — the bottom of every stack is the spec`);
      if (errs.length) deny(`\`gh stack ${sub2}\` rejected:\n- ${errs.join('\n- ')}`);
      if (layers.some((b) => parseBranch(cfg, b)?.type !== 'spec'))
        requireSpecApproved({ ...info, type: 'impl' }, `\`gh stack ${sub2}\` with implementation layers`);
    }
  }
}

let simulatedBranch = null;
function checkCommand(cmd) {
  for (const seg of String(cmd).split(/&&|\|\||;|\||\r?\n/)) {
    const s = seg.trim();
    if (s) checkSegment(s);
  }
}

// ---------- file edit rules ----------
function checkFileEdit(paths) {
  const branch = currentBranch();
  if (!branch || isExempt(cfg, branch)) return;
  const rel = paths.map((p) => p.replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', ''));
  if (isTrunk(cfg, branch)) {
    const bad = rel.filter((p) => !matchAny(cfg.specPaths, p));
    if (bad.length)
      deny(`you are on \`${branch}\`. Code changes start only after an approved spec. Write the spec/plan first (spec paths are allowed here), then \`gh stack init <feature>/spec\`. Blocked: ${bad.join(', ')}`);
    return;
  }
  const info = parseBranch(cfg, branch);
  if (!info) return; // non-stack branch: commit/push rules still apply
  requireSpecApproved(info, `editing files on \`${branch}\``);
  const errs = checkLayerPaths(cfg, info.type, rel.map((path) => ({ path })));
  if (errs.length) deny(`edit rejected on layer \`${branch}\`:\n- ${errs.join('\n- ')}\nSwitch layer with \`gh stack checkout\` or add one with \`gh stack add\`.`);
}

// ---------- dispatch ----------
const command = args.command ?? args.cmd ?? args.script;
if (command && (/bash|shell|powershell|terminal|run/i.test(toolName) || !toolName)) checkCommand(command);
else if (cfg.agent?.enforceFileEdits && /edit|create|write|replace|patch|insert/i.test(toolName)) {
  const paths = [args.path, args.filePath, args.file_path, args.filename, ...(args.paths || []), ...(args.files || [])]
    .filter((p) => typeof p === 'string');
  if (paths.length) checkFileEdit(paths);
}
allow();
