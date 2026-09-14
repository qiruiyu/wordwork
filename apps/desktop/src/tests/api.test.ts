import { describe, expect, it, vi, afterEach } from 'vitest';
import { ApiClient, ApiError, sha256Hex, validateServerUrl } from '../lib/api';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('服务器地址校验', () => {
  it('拒绝空地址', () => {
    expect(validateServerUrl('   ')).toBe('请填写服务器地址');
  });

  it('拒绝非 http(s) 协议', () => {
    expect(validateServerUrl('ftp://example.com')).toMatch(/只支持 https/);
  });

  it('拒绝公网明文 http', () => {
    expect(validateServerUrl('http://docx.example.com')).toMatch(/必须使用 https/);
  });

  it('允许 https 地址', () => {
    expect(validateServerUrl('https://docx.example.com')).toBeNull();
  });

  it('允许本机 http 调试地址', () => {
    expect(validateServerUrl('http://127.0.0.1:8000')).toBeNull();
    expect(validateServerUrl('http://localhost:8000')).toBeNull();
  });
});

describe('ApiClient 请求行为', () => {
  it('去掉地址末尾多余的斜杠', () => {
    expect(new ApiClient('https://docx.example.com///').baseUrl).toBe('https://docx.example.com');
  });

  it('断网时抛出中文 network 错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new ApiClient('https://docx.example.com', 'token');
    await expect(client.listProjects()).rejects.toMatchObject({ kind: 'network' });
    await expect(client.listProjects()).rejects.toThrow(/无法连接服务器/);
  });

  it('地址写错导致连不上时提示检查服务器地址', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const client = new ApiClient('https://typo.exmaple.com');
    const error = (await client.health().catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('network');
    expect(error.status).toBe(0);
    expect(error.message).toMatch(/无法连接服务器/);
    expect(error.message).toMatch(/服务器地址/);
  });

  it('地址指向别的服务（非 JSON 响应）时给出可读错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>404 Not Found</body></html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const client = new ApiClient('https://wrong-service.example.com');
    const error = (await client.health().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('server');
    expect(error.message).toBe('服务器返回 404');
  });

  it('把 HTML 当成成功响应时不会当成数据使用', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>hello</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const client = new ApiClient('https://wrong-service.example.com');
    expect(await client.health()).toBe('<html>hello</html>');
  });

  it('422 校验错误展开成中文明细行', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: [{ msg: '字段缺失' }, { msg: '长度不足' }] }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ApiClient('https://docx.example.com', 'token');
    const error = (await client.createProject('').catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('validation');
    expect(error.detailLines).toEqual(['字段缺失', '长度不足']);
  });

  it('401 映射为 auth 错误并保留服务端中文提示', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: '登录状态已失效，请重新登录' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ApiClient('https://docx.example.com');
    const error = await client.me().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).kind).toBe('auth');
    expect((error as ApiError).message).toBe('登录状态已失效，请重新登录');
  });

  it('409 冲突时保留 conflicts 明细', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            message: '存在多人冲突',
            conflicts: [{ id: 1, anchor: 'word/document.xml|paragraph|paraId:X', incoming_author: '学生甲' }],
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new ApiClient('https://docx.example.com', 'token');
    const error = (await client.publishResult(1).catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe('conflict');
    expect(error.message).toBe('存在多人冲突');
    const detail = error.detail as { detail: { conflicts: unknown[] } };
    expect(detail.detail.conflicts).toHaveLength(1);
  });

  it('登录请求不带 Authorization', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 't', token_type: 'bearer', member: { id: 1, username: 'teacher', role: 'teacher' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ApiClient('https://docx.example.com', 'stale-token');
    await client.login('teacher', 'secret');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('受保护请求带上 Bearer token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const client = new ApiClient('https://docx.example.com', 'abc123');
    await client.listProjects();
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer abc123');
  });

  it('下载时解析 Content-Disposition 文件名', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="abc.docx"' },
      }),
    );
    const client = new ApiClient('https://docx.example.com', 'token');
    const result = await client.downloadVersion(7);
    expect(result.filename).toBe('abc.docx');
    expect(result.bytes.length).toBe(3);
  });
});

describe('sha256Hex', () => {
  it('与已知摘要一致', async () => {
    const bytes = new TextEncoder().encode('abc');
    expect(await sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('对 subarray 也返回正确摘要', async () => {
    const padded = new TextEncoder().encode('xxabcxx');
    expect(await sha256Hex(padded.subarray(2, 5))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
