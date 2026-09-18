/**
 * The upload rules the contract fixes, mirrored here so a file the server will
 * refuse is caught before the bytes are read rather than at the end of a PUT.
 * The server decides: this only saves a person the wait, and every refusal it
 * names is one the contract also raises.
 */

/**
 * The content types the presign route accepts. `image/svg+xml` is absent on
 * purpose, because an SVG served from the bucket origin is a script.
 */
export const UPLOAD_CONTENT_TYPES: string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

/** The ceiling the presign route caps `size_bytes` at, in bytes. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Whether the type is one the presign route will sign a URL for. */
export const isAllowedUploadType = (contentType: string): boolean =>
  UPLOAD_CONTENT_TYPES.includes(contentType);

/** How a byte count reads in the interface. */
export const sizeLabel = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Why this file would be refused, or null when it would be accepted. The
 * wording matches what the contract's `UNSUPPORTED_MEDIA_TYPE` and
 * `UPLOAD_TOO_LARGE` mean, so a person reads the same reason either way.
 */
export const describeUploadRefusal = (file: File): string | null => {
  if (!isAllowedUploadType(file.type)) {
    return 'That file type cannot be attached. Images, PDFs, text, CSV, ZIP and Office documents are accepted.';
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `That file is ${sizeLabel(file.size)}, above the ${sizeLabel(MAX_UPLOAD_BYTES)} limit.`;
  }
  return null;
};
