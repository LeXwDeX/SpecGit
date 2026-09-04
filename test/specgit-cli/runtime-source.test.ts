import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { makeTempDir, rmDir } from '../specgit/helpers/temp-repo.js';

describe('controlled Actions ownership source embedding', () => {
  it('renders identical workflow bytes from LF and CRLF runtime source without changing the embedded program', () => {
    const root = makeTempDir('specgit-runtime-source-');
    try {
      mkdirSync(join(root, 'cli'));
      mkdirSync(join(root, 'harness-runtime'));
      const generator = join(root, 'cli', 'wait-step.mjs');
      const source = readFileSync(new URL('../../src/cli/wait-step.ts', import.meta.url), 'utf8');
      writeFileSync(generator, transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      }).outputText);
      const runtime = readFileSync(new URL('../../src/harness-runtime/actions-ownership.mjs', import.meta.url), 'utf8')
        .replace(/\r\n?/g, '\n');
      const render = (program: string) => {
        writeFileSync(join(root, 'harness-runtime', 'actions-ownership.mjs'), program);
        const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
          input: `import { waitStepYaml } from ${JSON.stringify(pathToFileURL(generator).href)}; process.stdout.write(waitStepYaml('gh'));`,
          encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      const lf = render(runtime);
      expect(render(runtime.replaceAll('\n', '\r\n'))).toBe(lf);
      expect(lf).not.toContain('\r');
      expect(parse(lf)[0].run).toContain(runtime.trimEnd());
    } finally { rmDir(root); }
  });
});
