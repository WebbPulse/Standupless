/**
 * The questions a form template asks in the new issue dialog. Covers that
 * each answer type draws its control, that a required question counts as
 * missing until answered, a required checkbox until checked, and that the
 * sent answers leave out blank text but always carry each checkbox.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FormFieldRead } from '../../types/Api';
import { FormQuestions, missingAnswers, sentAnswers } from './FormQuestions';

const FIELDS: FormFieldRead[] = [
  {
    key: 'f1',
    label: 'What happened?',
    type: 'long_text',
    required: true,
    options: [],
  },
  {
    key: 'f2',
    label: 'Browser',
    type: 'short_text',
    required: false,
    options: [],
  },
  {
    key: 'f3',
    label: 'Severity',
    type: 'select',
    required: true,
    options: [{ value: 'Blocker' }, { value: 'Minor' }],
  },
  {
    key: 'f4',
    label: 'I checked the docs',
    type: 'checkbox',
    required: true,
    options: [],
  },
];

describe('FormQuestions', () => {
  it('draws a control for each question and reports answers by key', () => {
    const onChange = vi.fn();
    render(<FormQuestions fields={FIELDS} answers={{}} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText(/What happened\?/), {
      target: { value: 'It broke' },
    });
    fireEvent.change(screen.getByLabelText(/Severity/), {
      target: { value: 'Minor' },
    });
    fireEvent.click(screen.getByLabelText(/I checked the docs/));

    expect(screen.getByLabelText(/Browser/)).toBeInTheDocument();
    expect(onChange).toHaveBeenNthCalledWith(1, { f1: 'It broke' });
    expect(onChange).toHaveBeenNthCalledWith(2, { f3: 'Minor' });
    expect(onChange).toHaveBeenNthCalledWith(3, { f4: true });
  });

  it('counts required questions missing until answered', () => {
    expect(missingAnswers(FIELDS, {}).map((field) => field.key)).toEqual([
      'f1',
      'f3',
      'f4',
    ]);
    expect(
      missingAnswers(FIELDS, { f1: '  ', f3: 'Blocker', f4: false }).map(
        (field) => field.key
      )
    ).toEqual(['f1', 'f4']);
    expect(
      missingAnswers(FIELDS, { f1: 'x', f3: 'Blocker', f4: true })
    ).toEqual([]);
  });

  it('sends text that was given and every checkbox', () => {
    expect(sentAnswers(FIELDS, { f1: 'x', f2: ' ' })).toEqual({
      f1: 'x',
      f4: false,
    });
  });
});
