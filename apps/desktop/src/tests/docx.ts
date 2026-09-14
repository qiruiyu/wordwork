/**
 * Minimal, dependency-free .docx builder for tests.
 *
 * Emits a stored (uncompressed) ZIP with only `[Content_Types].xml` and
 * `word/document.xml`, which is exactly the shape the server validates. All
 * fixture text is generated here, so no real document ever enters the repo.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

interface Entry {
  name: Uint8Array;
  data: Uint8Array;
  crc: number;
  offset: number;
}

function u16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';

/** Build a .docx whose paragraphs carry stable `w14:paraId` anchors. */
export function docxBytes(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map(
      (text, index) =>
        `<w:p w14:paraId="${(index + 1).toString(16).toUpperCase().padStart(8, '0')}">` +
        `<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`,
    )
    .join('');
  const document =
    '<?xml version="1.0"?>' +
    `<w:document xmlns:w="${W}" xmlns:w14="${W14}"><w:body>${body}<w:sectPr/></w:body></w:document>`;

  const entries: Entry[] = [];
  const local: number[] = [];
  for (const [name, text] of [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['word/document.xml', document],
  ] as const) {
    const nameBytes = bytes(name);
    const data = bytes(text);
    const crc = crc32(data);
    const offset = local.length;
    local.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...data,
    );
    entries.push({ name: nameBytes, data, crc, offset });
  }

  const directory: number[] = [];
  for (const entry of entries) {
    directory.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(entry.crc),
      ...u32(entry.data.length),
      ...u32(entry.data.length),
      ...u16(entry.name.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(entry.offset),
      ...entry.name,
    );
  }
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(directory.length),
    ...u32(local.length),
    ...u16(0),
  ];
  return new Uint8Array([...local, ...directory, ...end]);
}
