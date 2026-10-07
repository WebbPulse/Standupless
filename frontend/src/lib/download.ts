/**
 * Saving text the app built as a file, for exports. The browser downloads a
 * temporary object URL through a hidden link, so no server round trip or
 * exposed header is needed for the file name.
 */

/** A file name part made of lowercase words joined by hyphens. */
export const fileSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'issues';

/** Today's date as `YYYY-MM-DD`, for a dated export name. */
export const todayStamp = (now: Date = new Date()): string =>
  now.toISOString().slice(0, 10);

/** Hands `text` to the browser as a download named `name`. */
export const downloadText = (
  text: string,
  name: string,
  type = 'text/csv;charset=utf-8'
): void => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
