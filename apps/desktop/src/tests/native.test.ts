import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { fromBase64, pickDocx, toBase64 } from '../lib/native';
import { docxBytes } from './docx';

/**
 * The Rust side base64-encodes anything binary that crosses the IPC boundary.
 * A `Uint8Array` annotation on the TypeScript side is only an assertion, so a
 * missing decode ships base64 text to the server instead of a ZIP — which the
 * upload endpoint then rejects as "not a valid .docx". These tests pin the
 * contract down at the boundary itself.
 */
describe('Tauri IPC 边界', () => {
  beforeEach(() => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    invokeMock.mockReset();
  });

  it('pick_docx 返回的 base64 被解码回原始字节', async () => {
    const original = docxBytes(['哈苏丹哈桑对哦好']);
    invokeMock.mockResolvedValue({
      path: 'C:\\Users\\lab\\Desktop\\实验.docx',
      name: '实验.docx',
      bytes: toBase64(original),
    });

    const picked = await pickDocx();

    expect(picked).not.toBeNull();
    expect(picked?.name).toBe('实验.docx');
    expect(picked?.bytes).toBeInstanceOf(Uint8Array);
    expect(picked?.bytes.length).toBe(original.length);
    expect(Array.from(picked?.bytes ?? [])).toEqual(Array.from(original));
  });

  it('解出来的字节是合法 ZIP 头，不会被服务端当成损坏文件', async () => {
    const original = docxBytes(['第一段']);
    invokeMock.mockResolvedValue({
      path: 'x.docx',
      name: 'x.docx',
      bytes: toBase64(original),
    });

    const picked = await pickDocx();

    // "PK\x03\x04" — 拿不到这个头就说明又把 base64 文本当成字节发出去了。
    expect(Array.from(picked?.bytes.subarray(0, 4) ?? [])).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('base64 往返对任意字节都成立', () => {
    const bytes = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 256));
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
