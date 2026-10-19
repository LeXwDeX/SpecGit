import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export function headingIds(markdown) {
  const seen = new Map();
  const ids = new Set();
  for (const line of prose(markdown).split('\n')) {
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const slug = match[1].toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/ /g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    ids.add(count ? `${slug}-${count}` : slug);
  }
  for (const match of markdown.matchAll(/<(?:a|h[1-6])\b[^>]*\b(?:id|name)=["']([^"']+)["']/g)) ids.add(match[1]);
  return ids;
}

function prose(markdown) {
  let fence = null;
  return markdown.split('\n').map(line => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (match && match[1][0] === fence[0] && match[1].length >= fence.length) fence = null;
      return '';
    }
    if (match) { fence = match[1]; return ''; }
    return line;
  }).join('\n');
}

export function checkDocumentation(root, files) {
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const documents = files.filter(file => file.endsWith('.md'));
  const failures = [];
  for (const file of documents) {
    const text = prose(read(file));
    const links = [...text.matchAll(/!?\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1].replace(/^<|>$/g, ''));
    links.push(...[...text.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)].map(m => m[1]));
    for (const original of links) {
      let link = original;
      const repository = link.match(/^https:\/\/github\.com\/LeXwDeX\/SpecGit\/(?:blob|tree)\/main\/(.*)$/);
      const wiki = link.match(/^https:\/\/github\.com\/LeXwDeX\/SpecGit\/wiki(?:\/(.*))?$/);
      if (repository) link = `/${repository[1]}`;
      else if (wiki) link = `/docs/wiki/${wiki[1] || 'Home'}`;
      else if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//')) continue;
      const [pathname, fragment] = link.split('#');
      let target = pathname ? (pathname.startsWith('/') ? pathname.slice(1) : path.join(path.dirname(file), pathname)) : file;
      target = decodeURIComponent(target);
      if (!repository && (file.startsWith('docs/wiki/') || wiki) && !path.extname(target)) target += '.md';
      const absolute = path.resolve(root, target);
      if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`) || !existsSync(absolute)) {
        failures.push(`${file}: missing target ${original}`); continue;
      }
      if (fragment && target.endsWith('.md') && statSync(absolute).isFile()
          && !headingIds(readFileSync(absolute, 'utf8')).has(decodeURIComponent(fragment))) {
        failures.push(`${file}: missing anchor ${original}`);
      }
    }
  }
  assert.equal(failures.length, 0, failures.join('\n'));
  return documents.length;
}

// The repository integration follows the installed shared CLI. Accept only
// exact current or published 2.13 stable blocks while the new CLI is developed;
// product generation tests still require the current asset verbatim.
export function checkStableEntry(guidance, entries) {
  const start = '<!-- specgit:project:v2:start -->';
  const end = '<!-- specgit:project:v2:end -->';
  assert.equal(guidance.split(start).length - 1, 1, 'AGENTS must contain one stable SpecGit start');
  assert.equal(guidance.split(end).length - 1, 1, 'AGENTS must contain one stable SpecGit end');
  const first = guidance.indexOf(start), last = guidance.indexOf(end);
  assert(last > first, 'AGENTS stable entry markers must be ordered');
  const block = guidance.slice(first, last + end.length);
  assert(entries.some(entry => block === `${start}\n## SpecGit 2\n\n${entry.trim()}\n${end}`), 'AGENTS must contain an exact supported local Skill entry');
}

export function checkRepositoryDocumentation(root) {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))];
  const count = checkDocumentation(root, files);
  const read = file => readFileSync(path.join(root, file), 'utf8');
  const version = JSON.parse(read('package.json')).version;
  const guidance = read('AGENTS.md');
  const entry = read('runtime/assets/prompts/host-entry.md').trim();
  checkStableEntry(guidance, [entry, read('runtime/tests/fixtures/host-entry-2.13.md')]);
  assert(!guidance.includes('<!-- specgit:v2:start -->'), 'Legacy generated guidance must be migrated');
  assert(read('CHANGELOG.md').includes(`# ${version}\n`), 'Current version missing from changelog');
  assert(read('.github/workflows/release-prepare.yml').includes(`default: ${version}\n`), 'Release default version drift');
  for (const file of ['bug_report.md', 'feature_request.md']) {
    for (const section of ['Why', 'Scope', 'Approach', 'Acceptance']) assert(read(`.github/ISSUE_TEMPLATE/${file}`).includes(`## ${section}\n`), `${file}: incomplete specification template`);
  }
  const sidebar = read('docs/wiki/_Sidebar.md');
  for (const file of files.filter(f => f.startsWith('docs/wiki/') && f.endsWith('.md') && !path.basename(f).startsWith('_'))) {
    assert(sidebar.includes(`](${path.basename(file, '.md')})`), `Wiki page missing from sidebar: ${file}`);
  }
  return count;
}
