#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const manifests = ['package.json', 'packages/shared/package.json', 'packages/worker/package.json', 'packages/web/package.json'];
const run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = (bin, args) => JSON.parse(run(bin, args));
const fail = message => { throw new Error(message); };

try {
  const [action, version, title, notesFile, ...extra] = process.argv.slice(2);
  if (!['prepare', 'publish'].includes(action) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') || extra.length) {
    fail('Usage: node scripts/release.mjs prepare X.Y.Z | publish X.Y.Z "Release title" notes-file');
  }
  const packages = manifests.map(path => [path, JSON.parse(readFileSync(path, 'utf8'))]);
  if (action === 'prepare') {
    if (title || notesFile) fail('prepare accepts only a version');
    const config = readFileSync('config.toml', 'utf8');
    if (!/^user_agent\s*=\s*"wsb-signals\/[^" ]+/m.test(config)) fail('Missing application user_agent');
    for (const [path, pkg] of packages) {
      pkg.version = version;
      writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    writeFileSync('config.toml', config.replace(/^(user_agent\s*=\s*"wsb-signals\/)[^" ]+/m, `$1${version}`));
    console.log(`Prepared ${version}. Refresh the lockfile, verify, commit, and push main before publishing.`);
    process.exit(0);
  }
  if (!title?.trim() || !notesFile || !readFileSync(notesFile, 'utf8').trim()) fail('A release title and nonempty notes file are required');
  if (packages.some(([, pkg]) => pkg.version !== version)) fail('Package versions are not aligned');
  if (!readFileSync('config.toml', 'utf8').includes(`wsb-signals/${version} `)) fail('Application user agent version is not aligned');
  if (run('git', ['status', '--porcelain'])) fail('Working tree must be clean');
  if (run('git', ['branch', '--show-current']) !== 'main') fail('Release from main only');
  const sha = run('git', ['rev-parse', 'HEAD']);
  const remote = run('git', ['ls-remote', '--exit-code', 'origin', 'refs/heads/main']).split(/\s+/)[0];
  if (remote !== sha) fail('origin/main does not match HEAD');
  const tag = `v${version}`;
  if (run('git', ['tag', '--list', tag]) || run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) fail('Tag already exists; never move or silently reuse published tags');
  const repo = json('gh', ['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner;
  const releases = json('gh', ['api', '--paginate', '--slurp', `repos/${repo}/releases?per_page=100`]).flat();
  if (releases.some(release => release.tag_name === tag)) fail('Release already exists');
  const runs = json('gh', ['api', `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&branch=main&event=push&per_page=100`]).workflow_runs;
  const ci = runs.filter(item => item.head_sha === sha).sort((a, b) => b.id - a.id)[0];
  if (!ci || ci.status !== 'completed' || ci.conclusion !== 'success') fail('The latest CI push run must succeed on the exact release SHA');
  run('git', ['tag', '-a', tag, sha, '-m', `${tag}: ${title}`]);
  run('git', ['push', 'origin', `refs/tags/${tag}`]);
  run('gh', ['release', 'create', tag, '--repo', repo, '--verify-tag', '--title', `${tag} — ${title}`, '--notes-file', notesFile, '--latest', '--draft=false', '--prerelease=false']);
  const release = json('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,url']);
  const target = run('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`]).split(/\s+/)[0];
  if (release.tagName !== tag || release.isDraft || release.isPrerelease || target !== sha) fail('Published release verification failed; investigate without moving the tag');
  console.log(`Published ${release.url} at ${sha} (CI run ${ci.id}).`);
} catch (error) {
  // Do not echo subprocess stderr: local configuration or credentials may appear there.
  console.error(error instanceof Error && !('status' in error) ? error.message : 'Release command failed. Inspect GitHub and local state before retrying; tags are never moved automatically.');
  process.exitCode = 1;
}
