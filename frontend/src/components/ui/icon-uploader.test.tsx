/**
 * The icon uploader and the avatar it draws. What matters is that a file the
 * server would refuse never leaves the browser, that an accepted one is handed
 * to the upload callback, that remove is offered only once an icon is set, and
 * that an image which fails to load falls back to the same initials as no
 * image at all.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Avatar from './avatar';
import IconUploader from './icon-uploader';

const onUpload = vi.fn<(file: File) => Promise<void>>();
const onRemove = vi.fn<() => Promise<void>>();
const createObjectURL = vi.fn<(file: Blob) => string>();

/** A file of a given type and size, without allocating the bytes. */
const fileOf = (type: string, size = 10): File => {
  const file = new File(['x'], 'icon', { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};

/** Renders the uploader with the shared callbacks. */
const renderUploader = (
  src: string | null,
  canEdit = true
): ReturnType<typeof render> =>
  render(
    <IconUploader
      label="Workspace logo"
      description="Shown in the switcher."
      name="Acme Corp"
      src={src}
      canEdit={canEdit}
      onUpload={onUpload}
      onRemove={onRemove}
    />
  );

/** Picks a file through the hidden input, as the browser's chooser would. */
const choose = (file: File): void => {
  fireEvent.change(screen.getByLabelText('Choose workspace logo image'), {
    target: { files: [file] },
  });
};

beforeEach(() => {
  onUpload.mockReset().mockResolvedValue(undefined);
  onRemove.mockReset().mockResolvedValue(undefined);
  createObjectURL.mockReset().mockReturnValue('blob:preview');
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('IconUploader', () => {
  it('shows the initials and an upload button when no icon is set', () => {
    renderUploader(null);
    expect(screen.getByText('AC')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Upload image' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('refuses an SVG before any upload', () => {
    renderUploader(null);
    choose(fileOf('image/svg+xml'));
    expect(
      screen.getByText('Choose a PNG, JPEG, GIF or WebP image.')
    ).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('refuses an image over 2 MB before any upload', () => {
    renderUploader(null);
    choose(fileOf('image/png', 2 * 1024 * 1024 + 1));
    expect(
      screen.getByText('Choose an image of 2 MB or less.')
    ).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('hands an accepted image to the upload callback', async () => {
    renderUploader(null);
    const file = fileOf('image/png');
    choose(file);
    await waitFor(() => {
      expect(onUpload).toHaveBeenCalledWith(file);
    });
    expect(createObjectURL).toHaveBeenCalledWith(file);
  });

  it('shows the error when the upload fails', async () => {
    onUpload.mockRejectedValueOnce(new Error('boom'));
    renderUploader(null);
    choose(fileOf('image/webp'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('offers replace and remove once an icon is set', async () => {
    renderUploader('https://api/icons/workspace/ws/abc');
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('shows no controls to someone who cannot edit', () => {
    renderUploader('https://api/icons/workspace/ws/abc', false);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Avatar', () => {
  it('renders the image when a source is set', () => {
    const { container } = render(
      <Avatar name="Ada Lovelace" src="https://api/icons/user/u/abc" />
    );
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://api/icons/user/u/abc'
    );
    expect(screen.queryByText('AL')).toBeNull();
  });

  it('falls back to the initials when the image fails to load', () => {
    const { container } = render(
      <Avatar name="Ada Lovelace" src="https://api/icons/user/u/abc" />
    );
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    if (image !== null) fireEvent.error(image);
    expect(screen.getByText('AL')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('draws the same initials with no source as before', () => {
    render(<Avatar name="Ada Lovelace" src={null} />);
    expect(screen.getByText('AL')).toBeInTheDocument();
  });
});
