/**
 * The Resources section on a project overview. Covers that links render in
 * order with their title or hostname and open in a new tab, that a favicon
 * that fails to load falls back to the link glyph, that the add form sends a
 * completed URL and a trimmed title and refuses a non-web address, that the
 * row menu edits, moves and removes, and that a reader without edit rights
 * sees no controls.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectLinkRead } from '../../types/Api';
import ProjectResources from './ProjectResources';

const link = (overrides: Partial<ProjectLinkRead>): ProjectLinkRead => ({
  link_id: 'lnk-1',
  project_id: 'prj-1',
  workspace_id: 'ws-1',
  url: 'https://example.com/spec',
  title: null,
  sort_order: 'V',
  created_by: 'user-1',
  created_at: '2026-10-24T00:00:00Z',
  updated_at: '2026-10-24T00:00:00Z',
  ...overrides,
});

const LINKS = [
  link({ link_id: 'lnk-1', title: 'Spec', sort_order: 'F' }),
  link({
    link_id: 'lnk-2',
    url: 'https://figma.com/file/1',
    sort_order: 'V',
  }),
];

const renderSection = (links: ProjectLinkRead[] = LINKS, canEdit = true) => {
  const onCreate = vi.fn(() => Promise.resolve());
  const onUpdate = vi.fn(() => Promise.resolve());
  const onRemove = vi.fn(() => Promise.resolve());
  render(
    <ProjectResources
      links={links}
      canEdit={canEdit}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onRemove={onRemove}
    />
  );
  return { onCreate, onUpdate, onRemove };
};

describe('ProjectResources', () => {
  it('lists links in order by title or hostname, opening in a new tab', () => {
    renderSection();

    const list = screen.getByRole('list', { name: 'Resources' });
    const anchors = within(list).getAllByRole('link');
    expect(anchors.map((anchor) => anchor.textContent)).toEqual([
      'Spec',
      'figma.com',
    ]);
    expect(anchors[0]).toHaveAttribute('href', 'https://example.com/spec');
    expect(anchors[0]).toHaveAttribute('target', '_blank');
    expect(anchors[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('falls back to the link glyph when the favicon does not load', () => {
    const { container } = render(
      <ProjectResources
        links={[LINKS[0] as ProjectLinkRead]}
        canEdit={false}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onRemove={vi.fn()}
      />
    );

    const icon = container.querySelector('img');
    expect(icon).toHaveAttribute('src', 'https://example.com/favicon.ico');
    if (icon !== null) fireEvent.error(icon);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('link-glyph')).toBeInTheDocument();
  });

  it('adds a link with a completed URL and a trimmed title', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderSection([]);

    await user.click(screen.getByRole('button', { name: 'Add link' }));
    await user.type(screen.getByRole('textbox', { name: 'URL' }), 'docs.dev/a');
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '  Docs ');
    const form = screen.getByRole('form', { name: 'Add link' });
    await user.click(within(form).getByRole('button', { name: 'Add link' }));

    expect(onCreate).toHaveBeenCalledWith({
      url: 'https://docs.dev/a',
      title: 'Docs',
    });
    expect(screen.queryByRole('form', { name: 'Add link' })).toBeNull();
  });

  it('refuses an address that is not a web URL', async () => {
    const user = userEvent.setup();
    const { onCreate } = renderSection([]);

    await user.click(screen.getByRole('button', { name: 'Add link' }));
    await user.type(
      screen.getByRole('textbox', { name: 'URL' }),
      'javascript:alert(1){Enter}'
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter a web address starting with http or https.'
    );
    expect(onCreate).not.toHaveBeenCalled();
  });

  it('edits, moves and removes a link from its menu', async () => {
    const user = userEvent.setup();
    const { onUpdate, onRemove } = renderSection();

    await user.click(screen.getByRole('button', { name: 'Spec actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const title = screen.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Design spec{Enter}');
    expect(onUpdate).toHaveBeenCalledWith('lnk-1', {
      url: 'https://example.com/spec',
      title: 'Design spec',
    });

    await user.click(screen.getByRole('button', { name: 'figma.com actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    const moved = onUpdate.mock.calls.at(-1) as unknown as [
      string,
      { sort_order: string },
    ];
    expect(moved[0]).toBe('lnk-2');
    expect(moved[1].sort_order < 'F').toBe(true);

    await user.click(screen.getByRole('button', { name: 'figma.com actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledWith(LINKS[1]);
  });

  it('shows a reader the links without edit controls', async () => {
    const user = userEvent.setup();
    renderSection(LINKS, false);

    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Spec actions' }));
    expect(
      screen.getByRole('menuitem', { name: 'Copy link' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  });

  it('renders nothing for a reader when the project has no links', () => {
    renderSection([], false);

    expect(screen.queryByRole('heading', { name: 'Resources' })).toBeNull();
  });
});
