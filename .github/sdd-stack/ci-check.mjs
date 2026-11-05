#!/usr/bin/env node
// Server-side enforcement. Runs in GitHub Actions on pull_request / pull_request_review and
// sets a commit status "sdd-stack" on each affected PR head. Make "sdd-stack" a required check.
import { readFileSync, appendFileSync } from 'node:fs';
import {
  loadConfig, parseBranch, isTrunk, isExempt, namingHelp,
  checkLayerPaths, checkLayerSize, specStatus, sh,
} from './lib.mjs';

const root = process.cwd();
const cfg = loadConfig(root);
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
const runUrl = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
const gh = (...a) => sh('gh', a, { maxBuffer: 64 * 1024 * 1024 });
const summary = (s) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, s + '\n');

function prFiles(number) {
  return JSON.parse(gh('api', '--paginate', '--slurp', `repos/{owner}/{repo}/pulls/${number}/files`)).flat()
    .map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions }));
}

function evaluate(pr) {
  const head = pr.head.ref, base = pr.base.ref;
  if (isExempt(cfg, head)) return { ok: true, msg: `exempt branch ${head}` };
  const info = parseBranch(cfg, head);
  if (!info) return { ok: false, errors: [`\`${head}\` is not a stack layer. ${namingHelp(cfg)}`] };

  const files = prFiles(pr.number);
  const errors = [...checkLayerPaths(cfg, info.type, files), ...checkLayerSize(cfg, info.type, files)];

  if (info.type === 'spec' && !isTrunk(cfg, base))
    errors.push(`the spec layer must be the bottom of the stack (base should be ${cfg.trunk[0]}, is \`${base}\`)`);

  if (info.type !== 'spec') {
    const st = specStatus(cfg, info.specBranch);
    if (!st.approved) errors.push(`spec not approved yet: ${st.reason}`);
    if (isTrunk(cfg, base) && st.pr?.state !== 'MERGED')
      errors.push(`\`${head}\` targets \`${base}\` directly — it must be stacked on the spec layer (use \`gh stack submit\`)`);
  }
  return { ok: errors.length === 0, errors, info };
}

function setStatus(pr, res) {
  const description = res.ok
    ? (res.info ? `${res.info.type} layer OK` : res.msg)
    : res.errors[0].replace(/`/g, '').slice(0, 139);
  gh('api', `repos/{owner}/{repo}/statuses/${pr.head.sha}`,
    '-f', `state=${res.ok ? 'success' : 'failure'}`, '-f', 'context=sdd-stack',
    '-f', `description=${description}`, '-f', `target_url=${runUrl}`);
  summary(`### #${pr.number} \`${pr.head.ref}\` → \`${pr.base.ref}\`: ${res.ok ? '✅ OK' : '❌ blocked'}`);
  if (!res.ok) summary(res.errors.map((e) => `- ${e}`).join('\n'));
}

// PRs to evaluate: the PR from the event, plus — when a spec PR is reviewed — every open layer of that feature.
const primary = event.pull_request;
const targets = [primary];
const pinfo = parseBranch(cfg, primary.head.ref);
if (pinfo?.type === 'spec') {
  const siblings = JSON.parse(gh('api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls?state=open&per_page=100')).flat()
    .filter((p) => p.number !== primary.number && parseBranch(cfg, p.head.ref)?.feature === pinfo.feature);
  targets.push(...siblings);
}

let primaryFailed = false;
for (const pr of targets) {
  let res;
  try { res = evaluate(pr); } catch (e) { res = { ok: false, errors: [`guard error: ${e.message}`] }; }
  setStatus(pr, res);
  if (pr === primary && !res.ok) primaryFailed = true;
  console.log(`#${pr.number} ${pr.head.ref}: ${res.ok ? 'OK' : 'BLOCKED\n  ' + res.errors.join('\n  ')}`);
}
process.exit(primaryFailed ? 1 : 0);
