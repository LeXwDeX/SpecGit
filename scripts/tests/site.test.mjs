import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pages = ['site/index.html', 'site/zh/index.html'];
const read = file => readFileSync(path.join(root, file), 'utf8');

test('site pages resolve every local reference and anchor', () => {
  for (const page of pages) {
    const html = read(page);
    for (const [, reference] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)) {
        assert(!reference.startsWith('http://'), `${page}: insecure external reference ${reference}`);
        continue;
      }
      assert(!reference.startsWith('/'), `${page}: root-absolute local reference breaks project Pages: ${reference}`);
      const [rawTarget, rawFragment] = reference.split('#');
      const target = path.resolve(path.dirname(path.join(root, page)), decodeURIComponent(rawTarget || '.'));
      assert(existsSync(target), `${page}: missing local target ${reference}`);
      const resolved = statSync(target).isDirectory() ? path.join(target, 'index.html') : target;
      assert(existsSync(resolved), `${page}: directory reference without index.html ${reference}`);
      if (rawFragment) {
        const ids = new Set([...readFileSync(resolved, 'utf8').matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
        assert(ids.has(decodeURIComponent(rawFragment)), `${page}: missing anchor ${reference}`);
      }
    }
  }
});

test('site pages stay static, local-only and free of tracking code', () => {
  for (const page of pages) {
    const html = read(page);
    assert(!/<script\b/i.test(html), `${page}: script elements are not allowed`);
    assert(!/<(?:img|iframe|object|embed|video|audio|source)\b/i.test(html), `${page}: embedded media is not allowed`);
    for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
      if (tag.includes('rel="stylesheet"')) assert(!/href="(?:https?:)?\/\//.test(tag), `${page}: third-party stylesheet`);
    }
    assert(html.includes('rel="stylesheet"'), `${page}: missing local stylesheet`);
    assert(!/google-analytics|googletagmanager|gtag\(|plausible\.io|umami|matomo|hotjar|clarity\.ms|segment\.(?:com|io)|mixpanel|amplitude|fullstory|sentry\.io|bugsnag/i.test(html), `${page}: tracking reference`);
  }
  const css = read('site/assets/style.css');
  assert(!/@import/i.test(css), 'site CSS must not import external styles');
  assert(!/url\(\s*['"]?(?:https?:)?\/\//i.test(css), 'site CSS must not load external assets');
});

test('English and Chinese pages carry the same commands and canonical links', () => {
  const english = read('site/index.html');
  const chinese = read('site/zh/index.html');
  assert(english.includes('<html lang="en">'));
  assert(chinese.includes('<html lang="zh-Hans">'));
  for (const fact of [
    'https://github.com/LeXwDeX/SpecGit/releases/latest',
    'docs/agent-install.md',
    'docs/supported-tools.md#support-matrix',
    'SHA256SUMS',
    '--agent generic',
    '--agent claude',
    '--agent codex',
    '--agent opencode',
  ]) {
    assert(english.includes(fact) && chinese.includes(fact), `both language pages must state: ${fact}`);
  }
});

test('Pages deployment is main-only and exposes the static site directory', () => {
  const workflow = parse(read('.github/workflows/pages.yml'));
  assert.deepEqual(Object.keys(workflow.on), ['push']);
  assert.deepEqual(workflow.on.push, { branches: ['main'] });
  const upload = workflow.jobs.build.steps.find(step => step.uses?.startsWith('actions/upload-pages-artifact@'));
  assert.equal(upload.with.path, 'site');
  assert(workflow.jobs.deploy.steps.some(step => step.uses?.startsWith('actions/deploy-pages@')));
  assert.deepEqual(workflow.jobs.deploy.permissions, { pages: 'write', 'id-token': 'write' });
  assert.equal(workflow.jobs.deploy.environment.name, 'github-pages');
});