import 'server-only';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError } from '@/lib/errors';

const ORIGINALS_DIR = path.join(
  process.env.PDF_DATA_DIR ?? path.join(process.cwd(), 'data'),
  'originals',
);
const IMAGES_DIR = path.join(ORIGINALS_DIR, 'images');

async function readFileOrNull(filePath: string): Promise<Buffer | null> {
  try {
    return await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Caller MUST call this before storePdf — storage does not validate file contents.
 * @returns true if the buffer starts with `%PDF-`, false otherwise
 */
export function validatePdfMagicBytes(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

export function getPdfPath(hash: string, dir = ORIGINALS_DIR): string {
  return path.join(dir, `${hash}.pdf`);
}

/**
 * Caller MUST validate magic bytes before calling — this function does not validate file contents.
 * @returns Hex SHA-256 hash of the buffer (use as the `upload://<hash>` URL suffix)
 */
export async function storePdf(buffer: Buffer, dir = ORIGINALS_DIR): Promise<string> {
  const hash = createHash('sha256').update(buffer).digest('hex');
  await mkdir(dir, { recursive: true });
  await writeFile(getPdfPath(hash, dir), buffer);
  return hash;
}

/** @throws NotFoundError if no file exists for the given hash */
export async function readPdf(hash: string, dir = ORIGINALS_DIR): Promise<Buffer> {
  const buf = await readFileOrNull(getPdfPath(hash, dir));
  if (!buf) throw new NotFoundError('PDF', hash);
  return buf;
}

/** For dedup checks — avoids reading a 50MB file just to test existence. */
export async function pdfExists(hash: string, dir = ORIGINALS_DIR): Promise<boolean> {
  return fileExists(getPdfPath(hash, dir));
}

/**
 * Extracts the SHA-256 hash from a path produced by getPdfPath().
 * @throws NotFoundError if the basename is not a 64-char hex string
 */
export function getPdfHashFromPath(filePath: string): string {
  const base = path.basename(filePath, '.pdf');
  if (!/^[0-9a-f]{64}$/.test(base)) throw new NotFoundError('PDF', filePath);
  return base;
}

/** No-op if already absent (idempotent). */
export async function deletePdf(hash: string, dir = ORIGINALS_DIR): Promise<void> {
  try {
    await unlink(getPdfPath(hash, dir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Filename must match `^img-\d{1,10}\.(jpe?g|png)$` — anchored, case-sensitive, max 10 digits. */
export function isValidPdfImageName(name: string): boolean {
  return /^img-\d{1,10}\.(jpe?g|png)$/.test(name);
}

function getPdfImagePath(hash: string, name: string, dir = IMAGES_DIR): string {
  return path.join(dir, hash, name);
}

/** @throws only on unexpected I/O errors; ENOENT is silently ignored on overwrite */
export async function storePdfImage(
  hash: string,
  name: string,
  buffer: Buffer,
  dir = IMAGES_DIR,
): Promise<void> {
  await mkdir(path.join(dir, hash), { recursive: true });
  await writeFile(getPdfImagePath(hash, name, dir), buffer);
}

/** @returns Buffer if found, null if the file does not exist */
export async function readPdfImage(
  hash: string,
  name: string,
  dir = IMAGES_DIR,
): Promise<Buffer | null> {
  return readFileOrNull(getPdfImagePath(hash, name, dir));
}

export async function pdfImageExists(
  hash: string,
  name: string,
  dir = IMAGES_DIR,
): Promise<boolean> {
  return fileExists(getPdfImagePath(hash, name, dir));
}

/** Removes the entire hash subdirectory. No-op if already absent (idempotent). */
export async function deletePdfImages(hash: string, dir = IMAGES_DIR): Promise<void> {
  await rm(path.join(dir, hash), { recursive: true, force: true });
}
