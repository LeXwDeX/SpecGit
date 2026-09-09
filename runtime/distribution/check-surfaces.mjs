import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function checkSurfaces(launcher, packageRoot) {
  const schemaRoot = path.join(packageRoot, 'schemas');
  const schemas = new Map(readdirSync(schemaRoot).filter(name => name.endsWith('.schema.json'))
    .map(name => [name, JSON.parse(readFileSync(path.join(schemaRoot, name), 'utf8'))]));
  const help = args => {
    const result = spawnSync(process.execPath, [launcher, ...args, '--help'], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return result.stdout;
  };
  const top = help([]);
  const commands = [...top.matchAll(/^  ([a-z][a-z-]+)\s{2,}/gm)].map(match => match[1]).filter(name => name !== 'help');
  assert(commands.length > 0);
  const optionSchemas = [...schemas.keys()].filter(name => name.endsWith('-options.schema.json') && name !== 'cli-options.schema.json')
    .map(name => name.replace('-options.schema.json', '')).sort();
  assert.deepEqual(commands.toSorted(), optionSchemas, 'Every installed subcommand must have exactly one option schema.');
  const flags = text => [...text.matchAll(/^\s+(?:-\w,\s+)?--([a-z][a-z-]+)/gm)].map(match => match[1]).filter(name => !['help', 'version'].includes(name));
  assert.deepEqual(flags(top).toSorted(), ['cwd', 'json']);
  assert.deepEqual(Object.keys(schemas.get('cli-options.schema.json').properties).toSorted(), ['cwd', 'json']);
  for (const command of commands) {
    const text = help([command]);
    const options = flags(text).filter(name => !['cwd', 'json'].includes(name)).map(name => name.replaceAll('-', '_'));
    if (command === 'issue') {
      assert(text.includes('<SPECS>'));
      options.push('specs');
    }
    assert.deepEqual(options.toSorted(), Object.keys(schemas.get(`${command}-options.schema.json`).properties).toSorted(), `${command} schema/help flags differ.`);
  }
  assert(schemas.has('declaration.schema.json') && schemas.has('report.schema.json'));
  const reference = readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  for (const command of commands) assert(reference.includes('`' + command + '`'), `${command} is missing from the installed reference.`);
  return { commands: commands.toSorted(), schemas: schemas.size, checks: ['installed_help', 'complete_option_names', 'reference_commands', 'declaration_and_report_schema'] };
}
