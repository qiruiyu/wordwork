import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock, pushToastMock, nativeMock, ctx } = vi.hoisted(() => {
  const apiMock = { listVersions: vi.fn(), downloadVersion: vi.fn(), restoreVersion: vi.fn() };
  const pushToastMock = vi.fn();
  const nativeMock = {
    pickSavePath: vi.fn(),
    saveDocument: vi.fn(),
    openWithSystem: vi.fn(),
    removeFile: vi.fn(),
  };
  return {
    apiMock,
    pushToastMock,
    nativeMock,
    ctx: {
      api: apiMock,
      pushToast: pushToastMock,
      member: { id: 7, username: 'student1', role: 'student' },
      workingCopies: [],
      upsertWorkingCopy: vi.fn(),
      removeWorkingCopy: vi.fn(),
      online: true,
      enqueueSubmission: vi.fn(),
      revision: 0,
    },
  };
});

vi.mock('../lib/store', () => ({ useApp: () => ctx }));
vi.mock('../lib/native', () => nativeMock);

import { VersionsPanel } from '../components/VersionsPanel';
import type { ProjectDetail, VersionSummary } from '../types';
import { mount } from './harness';

const PROJECT: ProjectDetail = {
  id: 1,
  name: '基金申请',
  owner_id: 1,
  is_owner: true,
  created_at: null,
  members: [],
  documents: [{ id: 10, name: '主文档.docx', current_version_id: 5 }],
};

function version(over: Partial<VersionSummary>): VersionSummary {
  return {
    id: 1,
    parent_id: null,
    sha256: 'a'.repeat(64),
    display_name: 'x.docx',
    kind: 'main',
    author: 'teacher',
    created_at: '2026-09-13T10:00:00.000Z',
    current: false,
    size_bytes: 2048,
    ...over,
  };
}

const VERSIONS: VersionSummary[] = [
  version({ id: 100, kind: 'main', current: true, display_name: 'main.docx' }),
  version({ id: 101, kind: 'redline', display_name: 'redline.docx' }),
  version({ id: 102, kind: 'submission', display_name: 'student1.docx' }),
];

async function panel() {
  return mount(<VersionsPanel project={PROJECT} isTeacher onChanged={() => undefined} />);
}

describe('版本历史：恢复入口只对可恢复的类型出现', () => {
  beforeEach(() => {
    apiMock.listVersions.mockReset().mockResolvedValue(VERSIONS);
    apiMock.downloadVersion.mockReset();
    apiMock.restoreVersion.mockReset();
    pushToastMock.mockReset();
    nativeMock.pickSavePath.mockReset();
    nativeMock.saveDocument.mockReset();
  });

  it('红线审阅稿没有「恢复」按钮，并说明原因', async () => {
    const ui = await panel();

    // main is current (no restore), submission is restorable, redline is not.
    expect(ui.buttons('恢复')).toHaveLength(1);
    expect(ui.text()).toContain('审阅用中间版本，不可恢复');
    expect(ui.text()).toContain('红线审阅稿');
  });

  it('点「恢复」用的是提交自己的版本 id，并把结果写回列表', async () => {
    apiMock.restoreVersion.mockResolvedValue(undefined);
    const ui = await panel();

    await ui.click(ui.buttons('恢复')[0]);

    expect(apiMock.restoreVersion).toHaveBeenCalledWith(102, 10);
    expect(pushToastMock).toHaveBeenCalledWith('success', expect.stringContaining('已把版本 #102 恢复为当前主版本'));
    // The list was reloaded, so the button is usable again.
    expect(ui.buttons('恢复')[0]?.disabled).toBe(false);
  });
});

describe('下载历史版本：busy 一定复位，失败原因是可读的一句话', () => {
  beforeEach(() => {
    apiMock.listVersions.mockReset().mockResolvedValue(VERSIONS);
    apiMock.downloadVersion.mockReset().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), filename: 'main.docx' });
    pushToastMock.mockReset();
    nativeMock.pickSavePath.mockReset();
    nativeMock.saveDocument.mockReset();
  });

  it('取消保存对话框后按钮立刻可用，不写文件也不报错', async () => {
    nativeMock.pickSavePath.mockResolvedValue(null);
    const ui = await panel();

    await ui.click(ui.buttons('下载')[0]);

    expect(nativeMock.saveDocument).not.toHaveBeenCalled();
    expect(pushToastMock).not.toHaveBeenCalled();
    // The old bug: `return` inside the try left the row spinning forever.
    expect(ui.buttons('下载')[0]?.disabled).toBe(false);
  });

  it('文件被 Word 占用时给出可读提示，并复位按钮', async () => {
    nativeMock.pickSavePath.mockResolvedValue('C:\\out\\main.docx');
    nativeMock.saveDocument.mockResolvedValue('文件正被 Word/WPS 占用，请关闭 Word/WPS 后重试。');
    const ui = await panel();

    await ui.click(ui.buttons('下载')[0]);

    expect(pushToastMock).toHaveBeenCalledWith('error', '无法保存下载文件', [
      '文件正被 Word/WPS 占用，请关闭 Word/WPS 后重试。',
    ]);
    expect(ui.buttons('下载')[0]?.disabled).toBe(false);
  });

  it('下载接口本身失败也复位按钮', async () => {
    apiMock.downloadVersion.mockRejectedValue(new Error('网络中断'));
    const ui = await panel();

    await ui.click(ui.buttons('下载')[0]);

    expect(pushToastMock).toHaveBeenCalledWith('error', '下载失败', ['网络中断']);
    expect(ui.buttons('下载')[0]?.disabled).toBe(false);
  });

  it('保存成功时按钮复位', async () => {
    nativeMock.pickSavePath.mockResolvedValue('C:\\out\\main.docx');
    nativeMock.saveDocument.mockResolvedValue(null);
    const ui = await panel();

    await ui.click(ui.buttons('下载')[0]);

    expect(pushToastMock).toHaveBeenCalledWith('success', '已下载到 C:\\out\\main.docx');
    expect(ui.buttons('下载')[0]?.disabled).toBe(false);
  });
});
