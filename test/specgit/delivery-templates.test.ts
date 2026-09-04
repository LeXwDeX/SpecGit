import { describe, expect, it } from 'vitest';
import { checkBodyConvention, renderDeliveryTemplate } from '../../src/record/templates.js';
import { samplePolicy } from '../specgit-cli/helpers.js';

describe('project delivery templates', () => {
  it('uses a selected template while preserving supplied meaningful content', () => {
    const policy = samplePolicy({ templates: { issue: { title: 'fix: {{summary}}', body: '## Why\n{{body}}', required_sections: ['Why'] } } });
    expect(renderDeliveryTemplate(policy, 'issue', { title: 'feat: improve login', body: 'Users cannot sign in.' }))
      .toEqual({ ok: true, value: { title: 'fix: improve login', body: '## Why\nUsers cannot sign in.' } });
  });
  it('rejects unknown template variables before creation', () => {
    const policy = samplePolicy({ templates: { pr: { body: '{{unsupported}}' } } });
    expect(renderDeliveryTemplate(policy, 'pr', { title: 'fix: login', body: 'Evidence' }))
      .toMatchObject({ ok: false, code: 'template_variable_invalid' });
  });
  it('rejects empty required sections and managed placeholders but permits code examples', () => {
    const policy = samplePolicy({ templates: { issue: { body: '{{body}}', required_sections: ['Why', 'Evidence'] } } });
    expect(checkBodyConvention(policy, 'issue', '## Why\nA regression\n## Evidence\nTODO')).toMatchObject({ ok: false, code: 'body_content_incomplete' });
    expect(checkBodyConvention(policy, 'issue', '## Why\nA regression\n## Evidence\nValidated against a real request.\n```\n{{literal}}\n```')).toEqual({ ok: true, value: true });
  });
  it('keeps legacy advisory scaffolds compatible until content validation is selected', () => {
    expect(checkBodyConvention(samplePolicy(), 'pr', 'TODO')).toEqual({ ok: true, value: true });
    expect(checkBodyConvention(samplePolicy({ validation: { bodies: true } }), 'pr', 'TODO')).toMatchObject({ ok: false });
  });
});
