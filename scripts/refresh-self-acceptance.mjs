#!/usr/bin/env node
// Refresh source-repository workflow bytes from the same generators used by init.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harnessWorkflowYaml, selfAcceptanceJobYaml } from '../dist/cli/harness-content.js';
import { completionWorkflowYaml } from '../dist/cli/completion-workflow.js';

const file = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const start = '# specgit:ci-acceptance:start';
const end = '# specgit:ci-acceptance:end';
const ciPath = file('.github/workflows/ci.yml');
const ci = readFileSync(ciPath, 'utf8');
const block = `${start}\n${selfAcceptanceJobYaml(true)}${end}\n`;
let updated;
if (!ci.includes(start) && !ci.includes(end)) {
  updated = `${ci.trimEnd()}\n\n${block}`;
} else {
  if (ci.split(start).length !== 2 || ci.split(end).length !== 2 || ci.indexOf(end) < ci.indexOf(start)) {
    throw new Error('CI acceptance markers must be unique and ordered.');
  }
  updated = ci.slice(0, ci.indexOf(start)) + block + ci.slice(ci.indexOf(end) + end.length).replace(/^\n/, '');
}
const { version } = JSON.parse(readFileSync(file('package.json'), 'utf8'));
writeFileSync(ciPath, updated);
writeFileSync(file('.github/workflows/specgit-accept.yml'), harnessWorkflowYaml());
writeFileSync(file('.github/workflows/specgit-complete.yml'), completionWorkflowYaml({ defaultBranch: 'main', version, selfHosted: true }));
