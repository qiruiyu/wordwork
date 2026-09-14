import { describe, expect, it } from 'vitest';
import { DRAFT_MAX_INTERVAL_MS, DRAFT_STABILITY_MS, shouldUploadDraft } from '../lib/drafter';

const T0 = 1_700_000_000_000;

function inputs(overrides: Partial<Parameters<typeof shouldUploadDraft>[0]> = {}) {
  return {
    currentSha: 'aaa',
    uploadedSha: null,
    watchedSha: 'aaa',
    watchedAt: T0,
    lastUploadAt: 0,
    now: T0 + DRAFT_STABILITY_MS,
    ...overrides,
  };
}

describe('草稿自动上传时机', () => {
  it('内容刚变化时不传，避免每次敲字都上传', () => {
    expect(shouldUploadDraft(inputs({ now: T0 + 1000 }))).toBe(false);
  });

  it('内容稳定超过 5 分钟后上传一次', () => {
    expect(shouldUploadDraft(inputs({ now: T0 + DRAFT_STABILITY_MS }))).toBe(true);
  });

  it('与上次草稿内容相同时不重复上传', () => {
    expect(shouldUploadDraft(inputs({ uploadedSha: 'aaa', lastUploadAt: T0 }))).toBe(false);
  });

  it('文件读不到（被 Word 独占/已删除）时不上传', () => {
    expect(shouldUploadDraft(inputs({ currentSha: null }))).toBe(false);
  });

  it('两次上传之间至少间隔 10 分钟', () => {
    const justUploaded = inputs({
      uploadedSha: 'old',
      lastUploadAt: T0 + DRAFT_STABILITY_MS,
      now: T0 + DRAFT_STABILITY_MS + 60_000,
    });
    expect(shouldUploadDraft(justUploaded)).toBe(false);

    const later = { ...justUploaded, now: T0 + DRAFT_STABILITY_MS + DRAFT_MAX_INTERVAL_MS };
    expect(shouldUploadDraft(later)).toBe(true);
  });
});
