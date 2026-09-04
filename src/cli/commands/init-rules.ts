import type { Policy, PolicyLanguage } from '../../record/policy.js';
import { DEFAULT_TAG_CATALOG, isTagSlug } from '../../tags/catalog.js';
import type { CommandContext } from '../types.js';
import { errorDiagnostic, type InitOutcome } from '../output.js';
import type { InitOptions } from './init-validation.js';

export interface ProjectRuleInteraction {
  selectRule?: (message: string, choices: Array<{ name: string; value: string }>, current: string) => Promise<string>;
  selectLabels?: (names: string[], selected: string[]) => Promise<string[]>;
}

export interface ProjectRuleSelection {
  language: PolicyLanguage;
  validation?: Policy['validation'];
  tags?: Policy['tags'];
}

function invalid(message: string): InitOutcome {
  return { exit: 2, errors: [errorDiagnostic('project_rules_invalid', message, {
    fix: 'Use --title-check yes|no, --label-check off|kind|project and repeat --allowed-label <slug>; use --configure-rules on a terminal for choices.',
  })] };
}

/** An explicit configuration session; upgrades preserve existing choices by default. */
export async function resolveProjectRules(
  options: InitOptions, ctx: CommandContext, root: string,
  language: PolicyLanguage, policy: Policy | undefined, interaction: ProjectRuleInteraction,
  gitlabHost?: string
): Promise<ProjectRuleSelection | InitOutcome> {
  if (options.titleCheck !== undefined && !['yes', 'no'].includes(options.titleCheck)) {
    return invalid('Title validation must be yes or no.');
  }
  if (options.labelCheck !== undefined && !['off', 'kind', 'project'].includes(options.labelCheck)) {
    return invalid('Label validation must be off, kind, or project.');
  }
  const configure = options.configureRules === true;
  if (configure && (options.json || !ctx.stdinIsTTY)) return invalid('Interactive project choices require a terminal without --json.');
  let titles = options.titleCheck ?? (policy?.validation?.titles ? 'yes' : 'no');
  let labels = options.labelCheck ?? policy?.validation?.labels ?? 'off';
  let selected = options.allowedLabel ?? policy?.tags?.map((tag) => tag.name) ?? [];
  if (selected.some((name) => !isTagSlug(name))) return invalid('Allowed labels must follow the project tag grammar.');

  if (configure) {
    const selectRule = interaction.selectRule ?? (async (message, choices, current) => {
      const { select } = await import('@inquirer/prompts');
      return select({ message, choices, default: current }, { output: process.stderr });
    });
    const chosenLanguage = await selectRule('Issue/PR language / 项目语言', [
      { name: 'English (en)', value: 'en' }, { name: '中文 (zh)', value: 'zh' },
    ], language);
    if (chosenLanguage !== 'en' && chosenLanguage !== 'zh') return invalid('Choose en or zh.');
    language = chosenLanguage;
    titles = await selectRule(language === 'zh'
      ? '校验标题：中文至少含一个汉字；英文不得含汉字'
      : 'Validate titles: English forbids Han characters; Chinese requires a Han character', [
      { name: 'Enable / 启用', value: 'yes' }, { name: 'Disable / 关闭', value: 'no' },
    ], titles);
    labels = await selectRule('Issue label convention / 标签规范', [
      { name: 'One kind:: type + declared extras / 一个类型及声明的扩展标签', value: 'kind' },
      { name: 'Selected project vocabulary / 项目自选词表', value: 'project' },
      { name: 'No label validation / 不校验标签', value: 'off' },
    ], labels);
    if (labels === 'project') {
      const facts = await ctx.git.facts(root);
      if (!facts.originUrl) return invalid('Selecting repository labels requires a configured origin.');
      const forge = gitlabHost === undefined ? ctx : ctx.withGitlabHost?.(gitlabHost) ?? ctx;
      const repo = await forge.parseRepoRef(facts.originUrl);
      if (!repo.ok) return { exit: 3, errors: [errorDiagnostic(repo.code, repo.message, { fix: repo.fix })] };
      const pool = await forge.gh.listRepoLabels(repo.value);
      if (!pool.ok) return { exit: 3, errors: [errorDiagnostic(pool.code, pool.message, { fix: pool.fix })] };
      const names = [...new Set([...pool.value.names.filter(isTagSlug), ...selected,
        ...DEFAULT_TAG_CATALOG.map((tag) => tag.name)])].sort();
      const selectLabels = interaction.selectLabels ?? (async (choices, defaults) => {
        const { checkbox } = await import('@inquirer/prompts');
        return checkbox({ message: 'Allowed project labels / 允许使用的标签',
          choices: choices.map((name) => ({ name, value: name, checked: defaults.includes(name) })),
          required: true,
        }, { output: process.stderr });
      });
      selected = await selectLabels(names, selected);
      if (selected.some((name) => !names.includes(name))) return invalid('Choose labels from the displayed vocabulary.');
    }
  }
  if (!['yes', 'no'].includes(titles) || !['off', 'kind', 'project'].includes(labels)) {
    return invalid('Choose a supported title and label rule.');
  }
  if (labels === 'project' && selected.length === 0) return invalid('Project label validation requires at least one allowed label.');
  const touched = configure || options.titleCheck !== undefined || options.labelCheck !== undefined;
  return {
    language,
    ...(touched ? { validation: { titles: titles === 'yes', labels: labels as 'off' | 'kind' | 'project' } } : {}),
    ...(configure && labels === 'project' || options.allowedLabel !== undefined ? {
      tags: [...new Set(selected)].map((name) => policy?.tags?.find((tag) => tag.name === name) ?? { name }),
    } : {}),
  };
}
