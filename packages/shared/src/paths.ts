/**
 * Path rules for the files inside a release. Enforced three times — when the CLI signs, when the
 * backend accepts a publish, and natively before a device writes anything — because a manifest is
 * only trustworthy about *content*: a valid signature over `../../etc/passwd` is still a valid
 * signature.
 *
 * @module paths
 */

/** Longest path we will write, in bytes of UTF-8. Well past any real bundler output. */
const MAX_PATH_BYTES = 512;

/**
 * Check one release-relative file path.
 *
 * @param path - the candidate path, as it appears in the manifest.
 * @returns `null` when the path is safe to write, otherwise a human-readable reason.
 *
 * @example
 * validatePath('drawable-xxhdpi/logo.png'); // null
 * validatePath('../escape');                // 'contains a ".." segment'
 */
export function validatePath(path: unknown): string | null {
  if (typeof path !== 'string' || path.length === 0) return 'must be a non-empty string';
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return `is longer than ${MAX_PATH_BYTES} bytes`;
  if (path.includes('\0')) return 'contains a NUL byte';
  if (path.includes('\\')) return 'contains a backslash (paths are POSIX)';
  if (path.startsWith('/')) return 'is absolute';
  // A Windows drive letter would be absolute on the publishing side even though it has no leading
  // slash, and would be a bizarre relative path on the device.
  if (/^[A-Za-z]:/.test(path)) return 'starts with a drive letter';
  for (const segment of path.split('/')) {
    if (segment === '') return 'contains an empty segment';
    if (segment === '.') return 'contains a "." segment';
    if (segment === '..') return 'contains a ".." segment';
  }
  return null;
}
