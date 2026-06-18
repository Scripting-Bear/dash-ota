/**
 * A minimal deterministic archive format ("SOA1") for an OTA payload — the JS/HBC bundle
 * plus its assets packed into one blob so the whole payload is encrypted and signed together
 * (C3/C4). Deterministic ordering (sorted paths) so the same inputs always produce the same
 * bytes. Native unpacks the decrypted archive and verifies each file against the manifest.
 *
 * Layout: magic "SOA1" (4B) | headerLen uint32 BE (4B) | header JSON | concatenated blobs.
 *
 * @module archive
 */

/** One file in the payload archive. */
export interface ArchiveFile {
  path: string;
  data: Buffer;
}

const MAGIC = 'SOA1';

/**
 * Pack files into a single deterministic archive buffer (paths sorted ascending).
 * @param files the payload files
 * @returns the archive bytes
 */
export function packArchive(files: ArchiveFile[]): Buffer {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const header = Buffer.from(JSON.stringify(sorted.map((f) => ({ path: f.path, size: f.data.length }))), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(header.length, 0);
  return Buffer.concat([Buffer.from(MAGIC, 'ascii'), lenBuf, header, ...sorted.map((f) => f.data)]);
}

/**
 * Unpack a "SOA1" archive buffer.
 * @param buf the archive bytes
 * @returns the files in archive (sorted) order
 * @throws {Error} on bad magic or truncation
 */
export function unpackArchive(buf: Buffer): ArchiveFile[] {
  if (buf.length < 8 || buf.subarray(0, 4).toString('ascii') !== MAGIC) {
    throw new Error('unpackArchive: bad archive magic');
  }
  const headerLen = buf.readUInt32BE(4);
  const headerEnd = 8 + headerLen;
  if (buf.length < headerEnd) throw new Error('unpackArchive: truncated header');
  const index = JSON.parse(buf.subarray(8, headerEnd).toString('utf8')) as { path: string; size: number }[];
  const out: ArchiveFile[] = [];
  let offset = headerEnd;
  for (const entry of index) {
    const end = offset + entry.size;
    if (buf.length < end) throw new Error(`unpackArchive: truncated blob for ${entry.path}`);
    out.push({ path: entry.path, data: Buffer.from(buf.subarray(offset, end)) });
    offset = end;
  }
  return out;
}
