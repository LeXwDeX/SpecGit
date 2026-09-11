import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const draft = 'https://json-schema.org/draft/2020-12/schema';
const staticNames = ['declaration.schema.json', 'report.schema.json'];
const retired = new Set(['finish', 'merge', 'promotion', 'accept', 'bind', 'unbind']);

export function readContract(executable, prefix = [], options = {}) {
  const result = spawnSync(executable, [...prefix, '--schema'], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema_version, 2);
  assert.equal(report.operation, 'schema');
  assert.equal(report.exit, 0);
  assert.equal(report.ok, true);
  const contract = report.evidence;
  assert.equal(contract.schema_version, 2);
  assert.equal(contract.cli_version, report.version);
  assert(Array.isArray(contract.command.arguments));
  assert(Array.isArray(contract.command.commands));
  assert(contract.input && contract.output);
  for (const command of contract.command.commands) assert(!retired.has(command.name), `Retired ${command.name} is executable.`);
  return contract;
}

function optionSchema(command) {
  const properties = {};
  const required = [];
  for (const argument of command.arguments) {
    if (!argument.long || ['help', 'version', 'schema', 'input-file'].includes(argument.long)) continue;
    const scalar = { type: argument.input_type };
    if (argument.possible_values.length && argument.input_type === 'string') scalar.enum = argument.possible_values;
    let shape = scalar;
    if (argument.accepts_array) {
      const array = { type: 'array', minItems: Math.max(1, argument.minimum_values ?? 1), items: scalar };
      if (argument.action !== 'Append' && Number.isSafeInteger(argument.maximum_values)) array.maxItems = argument.maximum_values;
      shape = { oneOf: [scalar, array] };
    }
    properties[argument.long] = { ...shape, ...(argument.help ? { description: argument.help } : {}) };
    if (argument.required) required.push(argument.long);
  }
  return {
    $schema: draft, title: `SpecGit ${command.path.join(' ') || 'global'} JSON options`,
    description: 'Generated from this packaged executable --schema. Keys are long option names without --. Positional arguments use the request args array. The clap contract records defaults, arity and relationships; runtime validation remains authoritative.',
    type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}),
    'x-specgit-command': command,
  };
}

/** Deterministic package assets; no separately maintained command/option registry. */
export function generatedSchemas(contract) {
  const schemas = new Map();
  schemas.set('cli-contract.schema.json', {
    $schema: draft, title: 'SpecGit installed CLI discovery contract',
    description: 'The x-specgit-contract value is the exact offline clap discovery metadata for this executable, including effects and output framing.',
    'x-specgit-contract': contract,
  });
  function visit(command) {
    assert(!command.path.some(name => retired.has(name)), "Retired command path cannot be packaged.");
    const name = command.path.length ? command.path.join('-') : 'cli';
    assert(/^[a-z][a-z-]*$/.test(name), 'Command path cannot be represented as an asset filename.');
    const filename = `${name}-options.schema.json`;
    assert(!schemas.has(filename), 'Command paths collide as asset filenames.');
    schemas.set(filename, optionSchema(command));
    for (const child of command.commands) if (child.name !== 'help') visit(child);
  }
  visit(contract.command);
  return schemas;
}

/** Stage on a host that can execute this actual target binary. */
export function writeSchemas(binary, schemaRoot, staticSchemaRoot) {
  const contract = readContract(binary);
  mkdirSync(schemaRoot, { recursive: true });
  assert.equal(readdirSync(schemaRoot).length, 0, 'Schema destination must be empty.');
  for (const [name, schema] of generatedSchemas(contract)) writeFileSync(path.join(schemaRoot, name), JSON.stringify(schema, null, 2) + '\n');
  for (const name of staticNames) {
    const schema = JSON.parse(readFileSync(path.join(staticSchemaRoot, name), 'utf8'));
    writeFileSync(path.join(schemaRoot, name), JSON.stringify(schema, null, 2) + '\n');
  }
  return { schema_version: contract.schema_version, cli_version: contract.cli_version, generated_from: 'target_executable' };
}

export function checkPlatformReference(reference, manifest) {
  const rows = [...reference.matchAll(/^\| ([^|\r\n]+) \| `(specgit-[a-z0-9-]+)` \|$/gm)];
  const names = rows.map(row => row[2]);
  assert.deepEqual(names.sort(), Object.keys(manifest.optionalDependencies).sort(), 'Installed reference platform inventory differs from package dependencies.');
  const labels = { 'specgit-linux-x64-gnu': 'Linux glibc x64', 'specgit-darwin-arm64': 'macOS arm64', 'specgit-win32-x64': 'Windows x64 MSVC' };
  for (const row of rows) assert.equal(row[1].trim(), labels[row[2]], `Platform label disagrees with ${row[2]}.`);
}

export function checkSurfaces(launcher, packageRoot, options = {}) {
  const schemaRoot = path.join(packageRoot, 'schemas');
  const schemas = new Map(readdirSync(schemaRoot).filter(name => name.endsWith('.schema.json'))
    .map(name => [name, JSON.parse(readFileSync(path.join(schemaRoot, name), 'utf8'))]));
  const contract = readContract(process.execPath, [launcher], options);
  const generated = generatedSchemas(contract);
  assert.deepEqual([...schemas.keys()].sort(), [...generated.keys(), ...staticNames].sort(), 'Installed schema inventory differs from executable.');
  for (const [name, schema] of generated) assert.deepEqual(schemas.get(name), schema, `${name} differs from installed clap contract.`);
  const commands = contract.command.commands.filter(c => c.name !== 'help');
  const invoke = args => {
    const result = spawnSync(process.execPath, [launcher, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, ...options });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  };
  for (const command of commands) {
    const scoped = readContract(process.execPath, [launcher, command.name], options);
    assert.equal(scoped.command.name, command.name);
    assert.deepEqual(scoped.command.arguments, command.arguments, `${command.name} scoped arguments differ from root discovery.`);
    assert.deepEqual(scoped.command.effects, command.effects, `${command.name} scoped effects differ from root discovery.`);
    const help = invoke([command.name, '--help']);
    assert.equal(help.exit, 0);
    assert.equal(typeof help.evidence.text, 'string');
  }
  const reference = readFileSync(path.join(packageRoot, 'README.md'), 'utf8');
  checkPlatformReference(reference, JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')));
  for (const command of commands) assert(reference.includes('`' + command.name + '`'), `${command.name} is missing from installed reference.`);
  const declaration = schemas.get('declaration.schema.json');
  assert(!('verification' in declaration.properties));
  assert.equal(declaration.properties.agent.properties.native_auto_merge.default, false);
  assert.equal(declaration.properties.agent.properties.close_issues_after_merge.default, false);
  const report = schemas.get('report.schema.json');
  for (const field of ['schema_version', 'version', 'operation', 'ok', 'status', 'exit', 'evidence', 'diagnostics', 'next_actions']) assert(report.required.includes(field), `Report schema omits ${field}.`);
  return { commands: commands.map(c => c.name).sort(), schemas: schemas.size, checks: ['installed_offline_schema', 'complete_command_option_type_effect_contract', 'scoped_schema', 'machine_help', 'reference_commands', 'declaration_and_report_schema'] };
}
