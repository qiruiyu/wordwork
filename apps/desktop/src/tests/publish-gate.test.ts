// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ApiError,
  MANUAL_REVIEW_STATUS,
  applyConflictsFrom,
  isTerminalSubmission,
  outstandingFrom,
  outstandingOf,
} from '../lib/api';
import type { Submission } from '../types';

function submission(id: number, author: string, status: string): Submission {
  return {
    id,
    author,
    author_id: id,
    created_at: null,
    note: '',
    status,
    version_id: id * 10,
    redline_version_id: null,
    resolved_version_id: null,
    redline_warnings: [],
  };
}

function conflictError(detail: unknown): ApiError {
  return new ApiError('conflict', 409, '冲突', { detail });
}

describe('发布本轮结果的门槛', () => {
  it('两名学生提交、只审阅一份时，未处理的另一份会挡住发布', () => {
    const submissions = [submission(1, 'student1', 'reviewed'), submission(2, 'student2', 'ready_for_review')];
    const blocked = outstandingOf(submissions);

    expect(blocked).toEqual([{ id: 2, author: 'student2', status: 'ready_for_review' }]);
    // The publish button is gated on this, and the server independently refuses with 409.
    expect(blocked.length === 0).toBe(false);
  });

  it('全部处理完之后才放行', () => {
    const submissions = [
      submission(1, 'student1', 'reviewed'),
      submission(2, 'student2', 'skipped'),
      submission(3, 'student3', 'rejected'),
    ];
    expect(outstandingOf(submissions)).toEqual([]);
    expect(submissions.every((s) => isTerminalSubmission(s.status))).toBe(true);
  });

  it('需要人工合并的提交不算已处理', () => {
    expect(isTerminalSubmission(MANUAL_REVIEW_STATUS)).toBe(false);
    expect(outstandingOf([submission(1, 'student1', MANUAL_REVIEW_STATUS)])).toHaveLength(1);
  });

  it('从服务端的 409 里读出未处理的提交列表', () => {
    const error = conflictError({
      message: '还有提交没有处理完',
      outstanding: [{ id: 7, author: 'student2', status: 'ready_for_review' }],
    });
    expect(outstandingFrom(error)).toEqual([{ id: 7, author: 'student2', status: 'ready_for_review' }]);
  });

  it('从服务端的 409 里读出需要人工合并的位置', () => {
    const error = conflictError({
      message: '需要人工合并',
      conflicts: [
        {
          match_key: 'word/document.xml|paragraph|00000002',
          part: 'word/document.xml',
          anchor: '00000002',
          kind: 'complex_edit',
          reason: 'fragment_edit_on_complex_block_requires_manual',
          detail: '该段落含 drawing 等对象',
        },
      ],
    });
    const conflicts = applyConflictsFrom(error);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].detail).toContain('含 drawing');
  });

  it('普通错误不会伪造出未处理列表或冲突', () => {
    const plain = new ApiError('server', 500, '炸了', null);
    expect(outstandingFrom(plain)).toEqual([]);
    expect(applyConflictsFrom(plain)).toEqual([]);
    expect(outstandingFrom('not-an-error')).toEqual([]);
  });
});
