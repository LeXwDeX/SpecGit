import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout.split('\0').filter(Boolean).filter((file) => fs.existsSync(path.join(ROOT, file)));
}

function markdownSources(files: string[]): string[] {
  const sources = files.filter((file) => file.endsWith('.md'));
  const wikiDir = path.join(ROOT, 'docs', 'wiki');
  if (fs.existsSync(wikiDir)) {
    for (const name of fs.readdirSync(wikiDir)) {
      const file = path.posix.join('docs/wiki', name);
      if (name.endsWith('.md') && !sources.includes(file)) sources.push(file);
    }
  }
  return sources.sort();
}

function proseOnly(markdown: string, stripInlineCode = true): string {
  const output: string[] = [];
  let fence: '`' | '~' | null = null;
  for (const line of markdown.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (marker) {
      const kind = marker[0] as '`' | '~';
      if (fence === null) fence = kind;
      else if (fence === kind) fence = null;
      output.push('');
      continue;
    }
    output.push(
      fence === null
        ? line.replace(/(`+)(.*?)\1/g, (_match, _ticks, inner: string) =>
            stripInlineCode ? '' : inner)
        : ''
    );
  }
  return output.join('\n');
}

function localDestinations(markdown: string): string[] {
  const prose = proseOnly(markdown);
  const destinations: string[] = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/g,
    /^\s*\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm,
    /\b(?:href|src)=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prose.matchAll(pattern)) {
      const destination = match.slice(1).find((part) => part !== undefined);
      if (destination) destinations.push(destination.replace(/&amp;/g, '&'));
    }
  }
  return destinations;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function headingSlug(value: string): string {
  // Extract heading text for an anchor lookup, never sanitized HTML. The
  // final character allowlist below defines the entire output alphabet.
  return value.split(/<[^>]*>/g).join('')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchorsFor(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const line of proseOnly(markdown, false).split('\n')) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (heading) {
      const base = headingSlug(heading);
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
    }
    for (const match of line.matchAll(/<(?:a|span)\s+(?:name|id)=["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function resolveLocalTarget(
  source: string,
  rawDestination: string,
  files: Set<string>
): { target?: string; fragment?: string; error?: string } {
  const destination = rawDestination.trim();
  if (
    destination === '' ||
    destination.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(destination)
  ) {
    return {};
  }

  const hashAt = destination.indexOf('#');
  const beforeHash = hashAt === -1 ? destination : destination.slice(0, hashAt);
  const fragment = hashAt === -1 ? undefined : safeDecode(destination.slice(hashAt + 1));
  const rawPath = safeDecode(beforeHash.split('?')[0]);
  const joined = rawPath === ''
    ? source
    : rawPath.startsWith('/')
      ? path.posix.normalize(rawPath.slice(1))
      : path.posix.normalize(path.posix.join(path.posix.dirname(source), rawPath));

  if (joined === '..' || joined.startsWith('../')) {
    return { error: `escapes the repository: ${rawDestination}` };
  }

  const candidates = [joined];
  if (!path.posix.extname(joined)) candidates.push(`${joined}.md`);
  candidates.push(path.posix.join(joined, 'README.md'));
  const target = candidates.find((candidate) => files.has(candidate));
  if (!target) return { error: `missing target: ${rawDestination}` };
  return { target, fragment };
}

describe('documentation link integrity', () => {
  it('every local link in every versioned Markdown document resolves, including anchors', () => {
    const versioned = trackedFiles();
    const docs = markdownSources(versioned);
    const files = new Set(versioned);
    for (const source of docs) files.add(source);
    for (const file of [...files]) {
      let parent = path.posix.dirname(file);
      while (parent !== '.') {
        files.add(parent);
        parent = path.posix.dirname(parent);
      }
    }

    const anchorCache = new Map<string, Set<string>>();
    const failures: string[] = [];
    for (const source of docs) {
      const markdown = fs.readFileSync(path.join(ROOT, source), 'utf8');
      for (const destination of localDestinations(markdown)) {
        const resolved = resolveLocalTarget(source, destination, files);
        if (resolved.error) {
          failures.push(`${source}: ${resolved.error}`);
          continue;
        }
        if (!resolved.target || !resolved.fragment || !resolved.target.endsWith('.md')) continue;
        let anchors = anchorCache.get(resolved.target);
        if (!anchors) {
          anchors = anchorsFor(fs.readFileSync(path.join(ROOT, resolved.target), 'utf8'));
          anchorCache.set(resolved.target, anchors);
        }
        const fragment = resolved.fragment.toLocaleLowerCase('en-US');
        if (!anchors.has(fragment)) {
          failures.push(`${source}: missing anchor '${destination}' in ${resolved.target}`);
        }
      }
    }

    expect(failures, failures.join('\n')).toEqual([]);
  });
});

describe('wiki consistency', () => {
  const wiki = (...parts: string[]) =>
    fs.readFileSync(path.join(ROOT, 'docs', 'wiki', ...parts), 'utf8');
  const pairs = [
    'Home',
    'Getting-Started',
    'Concepts',
    'CLI-Reference',
    'Team-Workflow',
    'GitLab-Support',
    'Provider-Architecture',
  ] as const;

  it('keeps exactly seven English/Chinese page pairs plus the sidebar', () => {
    const expected = [
      ...pairs.flatMap((name) => [`${name}.md`, `${name}-zh.md`]),
      '_Sidebar.md',
    ].sort();
    expect(fs.readdirSync(path.join(ROOT, 'docs', 'wiki')).filter((name) => name.endsWith('.md')).sort())
      .toEqual(expected);
  });

  it('covers the current command, verdict, upgrade, validation, and completion contracts', () => {
    const allEnglish = pairs.map((name) => wiki(`${name}.md`)).join('\n');
    for (const command of [
      'init', 'setup', 'issue', 'pr', 'finish', 'bind', 'unbind', 'status', 'accept', 'doctor',
    ]) {
      expect(allEnglish, `Wiki must name specgit ${command}`).toContain(`specgit ${command}`);
    }
    expect(wiki('Getting-Started.md')).toMatch(/npm install -g specgit@latest/);
    expect(wiki('Getting-Started.md')).toContain('init --force');
    expect(wiki('Getting-Started.md')).toContain('specgit setup');
    expect(wiki('CLI-Reference.md')).toMatch(/0.*1.*2.*3.*130/s);
    expect(wiki('CLI-Reference.md')).toContain('--json');
    expect(wiki('CLI-Reference.md')).toMatch(/Scripts must branch on exit codes and JSON fields/i);
    expect(wiki('Concepts.md')).toMatch(/accepted[\s\S]*completed/i);
    expect(wiki('Team-Workflow.md')).toContain('specgit pr --merge');
    expect(wiki('Team-Workflow.md')).toMatch(/repair issue/i);
    expect(wiki('GitLab-Support.md')).toContain('>= 19.2.4 < 19.4.0');
    expect(wiki('GitLab-Support.md')).toContain('gitlab_version_unverified');
    expect(wiki('Provider-Architecture.md')).toMatch(/local git/i);
    expect(wiki('Provider-Architecture.md')).toMatch(/\bgh\b/);
    expect(wiki('Provider-Architecture.md')).toMatch(/\bglab\b/);
    expect(allEnglish).toMatch(/validation\.titles/);
    expect(allEnglish).toMatch(/validation\.labels/);
    expect(allEnglish).toMatch(/validation\.bodies/);
  });
});
