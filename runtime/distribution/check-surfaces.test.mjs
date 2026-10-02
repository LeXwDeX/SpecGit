import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertProjectOnlySurface, checkSurfaces, writeSchemas } from './check-surfaces.mjs';

const staticSchemas = fileURLToPath(new URL('../schemas', import.meta.url));
// Windows cannot exec a shebang script without a shell; the .cmd launcher plus
// shell spawn option keeps the same stub executable on all three CI platforms.
const spawnOptions = {
  ...(process.platform === 'win32' ? { shell: true } : {}),
  env: { ...process.env, SPECGIT_SURFACE_TEST_OPTIONS: 'propagated' },
};

const argument = (long, extra = {}) => ({ accepts_array: false, action: 'Set', conflicts: [], defaults: [], global: false, help: null,
  id: long.replaceAll('-', '_'), input_type: 'string', long, maximum_values: 1, minimum_values: 1, position: null, possible_values: [], required: false, short: null, ...extra });
const booleanFlag = long => argument(long, { action: 'SetTrue', defaults: ['false'], input_type: 'boolean', maximum_values: 0, minimum_values: 0 });

function commandSurface({ legacy }) {
  const observer = () => legacy ? [argument('state-root')] : [];
  return {
    setup: [
      argument('scope', { defaults: legacy ? ['global'] : ['project'], possible_values: legacy ? ['global', 'project'] : ['project'], help: 'Integration scope' }),
      argument('agent', { accepts_array: true, action: 'Append', help: 'Select an integration explicitly; repeat for multiple agents', possible_values: ['generic', 'claude', 'codex', 'opencode'] }),
      ...(legacy
        ? [argument('root'), argument('provider', { possible_values: ['github', 'gitlab'] }), argument('api-host'), booleanFlag('register-claude'), argument('claude-settings'),
          booleanFlag('register-codex'), argument('codex-root'), booleanFlag('register-opencode'), argument('opencode-root')]
        : [booleanFlag('opencode-claude-hooks')]),
      booleanFlag('uninstall'), booleanFlag('dry-run'), argument('rollback'),
    ],
    watch: [argument('request'), argument('session'), argument('goal'), ...observer(), booleanFlag('once')],
    hook: [argument('event'), booleanFlag('observe'), ...observer()],
    inbox: [argument('request'), argument('session'), argument('goal'), ...observer(), booleanFlag('no-refresh'), booleanFlag('ack')],
  };
}

function surfaceContract({ legacy }) {
  const surface = commandSurface({ legacy });
  const command = (name, arguments_) => ({ name, path: [name], arguments: arguments_, commands: [], effects: [] });
  return {
    schema_version: 2, cli_version: '2.4.0',
    command: { name: 'specgit', path: [], arguments: [booleanFlag('json'), booleanFlag('human')],
      commands: [command('setup', surface.setup), command('watch', surface.watch), command('hook', surface.hook), command('inbox', surface.inbox)], effects: [] },
    input: { media: 'application/json' }, output: { media: 'application/json' },
  };
}

const stubLogic = contract => `const contract=${JSON.stringify(contract)};
if(process.env.SPECGIT_SURFACE_TEST_OPTIONS!=='propagated')process.exit(3);
const frame=command=>JSON.stringify({schema_version:2,version:'2.4.0',operation:'schema',exit:0,ok:true,
  evidence:{schema_version:2,cli_version:'2.4.0',command,input:{},output:{}}});
const[, ,first,second]=process.argv;
const child=contract.command.commands.find(c=>c.name===first);
if(second==='--schema')process.stdout.write(frame(child));
else if(first==='--schema')process.stdout.write(frame(contract.command));
else if(second==='--help')process.stdout.write(JSON.stringify({exit:0,evidence:{text:(first??'specgit')+' usage'}}));
else process.exit(2);
`;

function stubFixture(t, { legacy }) {
  const root = mkdtempSync(path.join(tmpdir(), 'specgit-surface-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logic = path.join(root, 'surface-stub.cjs');
  writeFileSync(logic, stubLogic(surfaceContract({ legacy })));
  const binary = path.join(root, process.platform === 'win32' ? 'specgit-stub.cmd' : 'specgit-stub');
  writeFileSync(binary, process.platform === 'win32'
    ? `@echo off\r\nnode "%~dp0surface-stub.cjs" %*\r\n`
    : `#!/usr/bin/env node\nrequire(${JSON.stringify(logic)});\n`);
  chmodSync(binary, 0o755);
  const packageRoot = path.join(root, 'package');
  writeSchemas(binary, path.join(packageRoot, 'schemas'), staticSchemas, spawnOptions);
  writeFileSync(path.join(packageRoot, 'README.md'), 'Installed reference: `setup` `watch` `hook` `inbox`.\n');
  return { binary, packageRoot };
}

test('the packaged installed surface enforces the permanent project-only 2.4 contract', t => {
  const f = stubFixture(t, { legacy: false });
  const surfaces = checkSurfaces(f.binary, f.packageRoot, spawnOptions);
  assert.deepEqual(surfaces.commands, ['hook', 'inbox', 'setup', 'watch']);
  assert(surfaces.checks.includes('permanent_project_only_surface'));
});

test('global setup registration and observer state-root flags cannot be packaged', t => {
  const f = stubFixture(t, { legacy: true });
  assert.throws(() => checkSurfaces(f.binary, f.packageRoot, spawnOptions), /Retired setup --[a-z-]+ remains.*project-only/s);
  for (const name of ['watch', 'hook', 'inbox']) {
    const contract = surfaceContract({ legacy: false });
    contract.command.commands.find(c => c.name === name).arguments.push(argument('state-root'));
    assert.throws(() => assertProjectOnlySurface(contract), new RegExp(`Retired ${name} --state-root`));
  }
  const scopeDrift = surfaceContract({ legacy: false });
  scopeDrift.command.commands.find(c => c.name === 'setup').arguments.find(a => a.long === 'scope').defaults = ['global'];
  assert.throws(() => assertProjectOnlySurface(scopeDrift), /scope must be project/);
  const agentDrift = surfaceContract({ legacy: false });
  agentDrift.command.commands.find(c => c.name === 'setup').arguments.find(a => a.long === 'agent').possible_values.push('global');
  assert.throws(() => assertProjectOnlySurface(agentDrift), /--agent/);
  const optIn = surfaceContract({ legacy: false });
  const setup = optIn.command.commands.find(c => c.name === 'setup');
  setup.arguments = setup.arguments.filter(a => a.long !== 'opencode-claude-hooks');
  assert.throws(() => assertProjectOnlySurface(optIn), /--opencode-claude-hooks/);
  const missing = surfaceContract({ legacy: false });
  missing.command.commands = missing.command.commands.filter(c => c.name !== 'setup');
  assert.throws(() => assertProjectOnlySurface(missing), /omits setup/);
});
