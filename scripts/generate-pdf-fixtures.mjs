/**
 * Generates minimal binary PDF fixtures for pdf-extractor unit tests.
 *
 * Run once: node scripts/generate-pdf-fixtures.mjs
 * Commit the resulting files in __tests__/mocks/fixtures/pdfs/
 *
 * Fixtures produced:
 *   minimal-text.pdf  — 1-page PDF with sufficient text for Tier 1 quality threshold
 *   multi-page-text.pdf — 3-page PDF, each page with 3+ sentences
 *   low-quality.pdf   — 1-page PDF with almost no text (< 100 chars)
 *   corrupted.pdf     — not a valid PDF (garbage bytes after magic header)
 *
 * Note: encrypted.pdf is simulated in tests via vi.mock('pdfjs-dist/legacy/build/pdf.mjs')
 * rather than a real encrypted file, because creating a pdfjs-compatible encrypted PDF
 * requires qpdf or equivalent tooling. The test README documents this.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../__tests__/mocks/fixtures/pdfs');
mkdirSync(OUT_DIR, { recursive: true });

/**
 * Builds a minimal but valid PDF buffer.
 * Each page receives its own content stream with the provided text.
 * Text is a plain ASCII string (parens and backslashes escaped for PDF literal strings).
 *
 * @param {string[]} pages - Array of text strings, one per page
 * @returns {Buffer}
 */
function buildPdf(pages) {
  // We build the PDF body first, then append the xref + trailer.
  let body = '%PDF-1.4\n%\x80\x81\x82\x83\n'; // binary comment marks file as binary
  const offsets = {}; // objId -> byte offset

  function addObj(id, dict, stream) {
    offsets[id] = body.length;
    if (stream !== undefined) {
      // stream must be a string; /Length must be exact
      const len = Buffer.byteLength(stream, 'latin1');
      const dictPart = dict ? `${dict} ` : '';
      body += `${id} 0 obj\n<< ${dictPart}/Length ${len} >>\nstream\n${stream}endstream\nendobj\n`;
    } else {
      body += `${id} 0 obj\n${dict}\nendobj\n`;
    }
  }

  const N = pages.length;
  // Page object IDs: 3, 5, 7, ... Content stream IDs: 4, 6, 8, ...
  const pageIds = Array.from({ length: N }, (_, i) => 3 + i * 2);
  const contentIds = Array.from({ length: N }, (_, i) => 4 + i * 2);

  // Object 1: Catalog
  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');

  // Object 2: Pages
  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${N} >>`);

  for (let i = 0; i < N; i++) {
    // Each page: multiple text runs at distinct absolute positions via Tm operator
    const lines = splitIntoLines(pages[i], 4);
    let stream = 'BT\n/F1 12 Tf\n';
    let y = 720;
    for (const line of lines) {
      const escaped = line.replace(/[()\\]/g, (c) => '\\' + c);
      // Tm requires the full 6-element CTM: a b c d e f (identity + translation)
      stream += `1 0 0 1 72 ${y} Tm\n(${escaped}) Tj\n`;
      y -= 20;
    }
    stream += 'ET\n';

    // Content stream has no /Type (it's just a raw stream, not an XObject)
    addObj(contentIds[i], '', stream);
    addObj(
      pageIds[i],
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`,
    );
  }

  // Build xref table
  const maxId = Math.max(...Object.keys(offsets).map(Number));
  const numObjs = maxId + 1;
  const xrefStart = body.length;

  let xref = 'xref\n';
  xref += `0 ${numObjs}\n`;
  xref += '0000000000 65535 f\r\n';
  for (let id = 1; id < numObjs; id++) {
    const off = offsets[id] !== undefined ? offsets[id] : 0;
    xref += `${String(off).padStart(10, '0')} 00000 n\r\n`;
  }
  xref += `trailer\n<< /Size ${numObjs} /Root 1 0 R >>\n`;
  xref += `startxref\n${xrefStart}\n%%EOF\n`;

  body += xref;
  return Buffer.from(body, 'latin1');
}

function splitIntoLines(text, count) {
  // Split text roughly evenly into `count` chunks
  const words = text.split(' ');
  const chunkSize = Math.ceil(words.length / count);
  const lines = [];
  for (let i = 0; i < words.length; i += chunkSize) {
    lines.push(words.slice(i, i + chunkSize).join(' '));
  }
  return lines.slice(0, count);
}

// --- minimal-text.pdf: 1 page, enough text for quality threshold ---
const minimalText = buildPdf([
  'This is a well-written article about software engineering and modern systems. ' +
    'The author discusses various aspects of distributed computing and microservices. ' +
    'Each section provides detailed explanations with concrete examples and code snippets. ' +
    'The content spans multiple topics including reliability, scalability, and observability. ' +
    'Readers will find practical advice on building production-grade systems at scale.',
]);
writeFileSync(join(OUT_DIR, 'minimal-text.pdf'), minimalText);
console.log('Generated minimal-text.pdf', minimalText.length, 'bytes');

// --- multi-page-text.pdf: 3 pages ---
const multiPageText = buildPdf([
  'Chapter one introduces the fundamental concepts of distributed systems and their trade-offs. ' +
    'The CAP theorem states that a distributed system cannot simultaneously guarantee consistency, ' +
    'availability, and partition tolerance. Engineers must choose which properties to prioritize.',

  'Chapter two covers consensus algorithms including Paxos and Raft used in distributed databases. ' +
    'These algorithms ensure that all nodes in a cluster agree on the same value even in the presence ' +
    'of network partitions and node failures in production deployments.',

  'Chapter three examines practical patterns for building resilient microservices architectures. ' +
    'Circuit breakers, bulkheads, and retry policies help services gracefully degrade under load. ' +
    'Observability through metrics, logs, and traces is essential for operating distributed systems.',
]);
writeFileSync(join(OUT_DIR, 'multi-page-text.pdf'), multiPageText);
console.log('Generated multi-page-text.pdf', multiPageText.length, 'bytes');

// --- low-quality.pdf: very little text (< 100 chars per page, < 3 sentences) ---
const lowQualityText = buildPdf(['Hi.']);
writeFileSync(join(OUT_DIR, 'low-quality.pdf'), lowQualityText);
console.log('Generated low-quality.pdf', lowQualityText.length, 'bytes');

// --- corrupted.pdf: valid magic bytes but malformed body ---
const corrupted = Buffer.concat([
  Buffer.from('%PDF-1.4\n', 'ascii'),
  Buffer.from('THIS IS NOT A VALID PDF STRUCTURE AT ALL\n0 0 obj garbage <<>> endobj\n', 'ascii'),
  // No xref, no trailer — pdfjs will throw InvalidPDFException
]);
writeFileSync(join(OUT_DIR, 'corrupted.pdf'), corrupted);
console.log('Generated corrupted.pdf', corrupted.length, 'bytes');

// --- encrypted.pdf: RC4-v1 encrypted PDF — pdfjs will call onPassword callback ---
// The O and U hashes are 32-byte zeroes; pdfjs will fail empty-password auth
// and call onPassword(callback, NEED_PASSWORD).
const encryptDictContent = [
  '/Filter /Standard',
  '/V 1',
  '/R 2',
  '/KeyLength 40',
  '/O <' + '00'.repeat(32) + '>',
  '/U <' + '00'.repeat(32) + '>',
  '/P -4',
].join(' ');

let encBody = '%PDF-1.4\n';
const encOffsets = {};

function addEncObj(id, dict) {
  encOffsets[id] = encBody.length;
  encBody += `${id} 0 obj\n${dict}\nendobj\n`;
}

addEncObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
addEncObj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
addEncObj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
addEncObj(4, `<< ${encryptDictContent} >>`);

const encXrefStart = encBody.length;
encBody += 'xref\n0 5\n';
encBody += '0000000000 65535 f\r\n';
for (let id = 1; id <= 4; id++) {
  encBody += `${String(encOffsets[id]).padStart(10, '0')} 00000 n\r\n`;
}
encBody += `trailer\n<< /Size 5 /Root 1 0 R /Encrypt 4 0 R >>\n`;
encBody += `startxref\n${encXrefStart}\n%%EOF\n`;

const encrypted = Buffer.from(encBody, 'ascii');
writeFileSync(join(OUT_DIR, 'encrypted.pdf'), encrypted);
console.log('Generated encrypted.pdf', encrypted.length, 'bytes');

console.log('\nAll fixtures generated in', OUT_DIR);
