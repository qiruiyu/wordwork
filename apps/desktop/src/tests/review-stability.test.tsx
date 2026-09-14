import { beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock, ctx } = vi.hoisted(() => {
  const apiMock = {
    getRound: vi.fn(),
    listSubmissions: vi.fn(),
    listConflicts: vi.fn(),
    getDiff: vi.fn(),
    listComments: vi.fn(),
  };
  return {
    apiMock,
    ctx: {
      api: apiMock,
      pushToast: vi.fn(),
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
vi.mock('../lib/native', () => ({
  pickDocx: vi.fn().mockResolvedValue(null),
  pickSavePath: vi.fn().mockResolvedValue(null),
  saveDocument: vi.fn().mockResolvedValue(null),
  readFile: vi.fn().mockResolvedValue(null),
  openWithSystem: vi.fn().mockResolvedValue(true),
  notify: vi.fn().mockResolvedValue(undefined),
  removeFile: vi.fn().mockResolvedValue(true),
}));

import { RoundPage } from '../components/RoundPage';
import { Caveat } from '../components/ui';
import type { DiffPayload, RoundDetail, Submission } from '../types';
import { mount } from './harness';

const ROUND: RoundDetail = {
  id: 3,
  number: 1,
  status: 'open',
  document_id: 4,
  document_name: '主文档.docx',
  project_id: 1,
  project_name: '基金申请',
  base_version_id: 19,
  base_version_name: 'main.docx',
  created_at: '2026-09-13T10:00:00.000Z',
};

const WARNING = 'high_risk_block_not_redlined:word/document.xml|paragraph|00000001';

const SUBMISSION: Submission = {
  id: 55,
  author: 'student2',
  author_id: 8,
  created_at: '2026-09-13T11:00:00.000Z',
  note: '改了公式那一段',
  status: 'ready_for_review',
  version_id: 60,
  redline_version_id: 61,
  resolved_version_id: null,
  redline_warnings: [WARNING],
};

const DIFF: DiffPayload = {
  submission_id: 55,
  status: 'ready_for_review',
  note: '改了公式那一段',
  redline_version_id: 61,
  resolved_version_id: null,
  redline_warnings: [WARNING],
  engine_available: true,
  hunks: [
    {
      id: 900,
      anchor: 'word/document.xml|paragraph|00000001',
      risk: 'high',
      decision: 'pending',
      operation: 'structure',
      before: '',
      after: '',
      context_before: '',
      context_after: '',
      author: 'student2',
      part: 'word/document.xml',
    },
  ],
};

describe('P1-1 三类提示互相区分', () => {
  it('Caveat 用不同的标签和语气渲染三种类别', async () => {
    for (const [kind, label, tone] of [
      ['design', '设计限制', 'info'],
      ['warning', '实际告警', 'warn'],
      ['required', '处理要求', 'error'],
    ] as const) {
      const ui = await mount(
        <Caveat kind={kind} title="标题">
          <p>正文</p>
        </Caveat>,
      );
      expect(ui.container.querySelector(`.banner.${tone}`)).not.toBeNull();
      expect(ui.container.querySelector('.caveat-kind')?.textContent).toBe(label);
      ui.unmount();
    }
  });

  it('提交列表顶部说明复杂对象不在此展开（设计限制）', async () => {
    seed();
    const ui = await mount(<RoundPage roundId={3} onBack={() => undefined} onChanged={() => undefined} />);

    expect(ui.text()).toContain('设计限制');
    expect(ui.text()).toContain('公式、图片等复杂对象不会在这里展开');
    expect(ui.text()).toContain('不是文件损坏');
    // A submission whose redline is incomplete is flagged in the list, not only inside the modal.
    expect(ui.text()).toContain('红线稿不完整');
    ui.unmount();
  });

  it('差异窗口里三种情况同时出现且不相同', async () => {
    seed();
    const ui = await mount(<RoundPage roundId={3} onBack={() => undefined} onChanged={() => undefined} />);

    await ui.click(ui.buttons('查看差异')[0]);

    expect(ui.text()).toContain('修改片段审阅');
    expect(ui.text()).toContain('设计限制');
    expect(ui.text()).toContain('实际告警');
    // A structural hunk is a merge instruction, not a rendering limit.
    expect(ui.text()).toContain('属于处理要求，必须人工合并');
    expect(ui.text()).toContain('高风险');
  });
});

describe('P2 决定片段时弹窗不卸载', () => {
  beforeEach(seed);

  it('revision 变化触发重新加载时，弹窗还是同一个 DOM 节点', async () => {
    const ui = await mount(<RoundPage roundId={3} onBack={() => undefined} onChanged={() => undefined} />);

    await ui.click(ui.buttons('查看差异')[0]);
    const modal = ui.container.querySelector('.modal');
    expect(modal).not.toBeNull();
    expect(ui.text()).toContain('修改片段审阅');

    // Every hunk decision writes an audit event; the event feed bumps `revision` and
    // this page reloads. Before the fix the reload swapped the whole subtree for a
    // spinner, which is what the teacher saw as a flash (and cost them their scroll).
    ctx.revision += 1;
    await ui.render(<RoundPage roundId={3} onBack={() => undefined} onChanged={() => undefined} />);

    expect(ui.container.querySelector('.modal')).toBe(modal);
    expect(ui.text()).toContain('修改片段审阅');
    expect(ui.buttons('查看差异')).toHaveLength(1);
  });
});

function seed() {
  apiMock.getRound.mockReset().mockResolvedValue(ROUND);
  apiMock.listSubmissions.mockReset().mockResolvedValue([SUBMISSION]);
  apiMock.listConflicts.mockReset().mockResolvedValue([]);
  apiMock.getDiff.mockReset().mockResolvedValue(DIFF);
  apiMock.listComments.mockReset().mockResolvedValue([]);
  ctx.revision = 0;
}
