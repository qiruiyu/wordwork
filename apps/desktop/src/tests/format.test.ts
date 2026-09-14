import { describe, expect, it } from 'vitest';
import { basename, formatBytes, formatTime, locationLabel, redlineWarningLabel } from '../lib/format';

describe('locationLabel', () => {
  it('把正文段落锚点翻译成中文', () => {
    expect(locationLabel('word/document.xml|paragraph|paraId:0000001A')).toBe('正文 · 段落');
  });

  it('识别表格单元格', () => {
    expect(locationLabel('word/document.xml|table_cell|body/tbl[0]/tr[0]/tc[1]/p[0]')).toBe('正文 · 表格单元格');
  });

  it('识别页眉与脚注', () => {
    expect(locationLabel('word/header1.xml|paragraph|header/1')).toBe('页眉 · 段落');
    expect(locationLabel('word/footnotes.xml|paragraph|2')).toBe('脚注 · 段落');
  });
});

describe('formatBytes', () => {
  it('处理空值与单位换算', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('formatTime', () => {
  it('解析服务端 UTC 时间', () => {
    const text = formatTime('2026-09-13T01:30:00Z');
    expect(text).not.toBe('—');
    expect(text).toContain('2026');
  });

  it('无法解析时原样返回', () => {
    expect(formatTime('not-a-date')).toBe('not-a-date');
    expect(formatTime(null)).toBe('—');
  });
});

describe('basename', () => {
  it('兼容 Windows 和 POSIX 路径', () => {
    expect(basename('C:\\Users\\a\\工作副本.docx')).toBe('工作副本.docx');
    expect(basename('/home/a/工作副本.docx')).toBe('工作副本.docx');
  });
});

describe('redlineWarningLabel', () => {
  it('把高风险段落告警说成人话', () => {
    const text = redlineWarningLabel('high_risk_block_not_redlined:word/document.xml|paragraph|paraId:0000001A');
    expect(text).toContain('正文 · 段落');
    expect(text).toContain('没有标出这处改动');
    expect(text).not.toContain('high_risk_block_not_redlined');
  });

  it('区分整块新增与整块删除', () => {
    expect(redlineWarningLabel('not_redlined_insert:word/document.xml|paragraph|paraId:0000002B')).toContain('整块新增');
    expect(redlineWarningLabel('not_redlined_delete:word/document.xml|paragraph|paraId:0000002B')).toContain('整块删除');
  });

  it('不认识的代码原样返回，方便排查', () => {
    expect(redlineWarningLabel('some_future_code')).toBe('some_future_code');
  });
});
