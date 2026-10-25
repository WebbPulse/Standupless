import { describe, expect, it } from 'vitest';
import { openingTemplateId } from './templateDefaults';

const list = {
  default_template_id: 'tp-members',
  non_member_default_template_id: 'tp-request',
};

describe('openingTemplateId', () => {
  it('answers the members default for a member', () => {
    expect(openingTemplateId(list, true)).toBe('tp-members');
  });

  it('answers the non-member default for someone outside the team', () => {
    expect(openingTemplateId(list, false)).toBe('tp-request');
  });

  it('reads an unknown membership as a member', () => {
    expect(openingTemplateId(list, undefined)).toBe('tp-members');
  });

  it('falls back to the members default when no non-member one is answered', () => {
    expect(
      openingTemplateId({ default_template_id: 'tp-members' }, false)
    ).toBe('tp-members');
  });

  it('answers none before the list loads', () => {
    expect(openingTemplateId(null, false)).toBeNull();
  });
});
