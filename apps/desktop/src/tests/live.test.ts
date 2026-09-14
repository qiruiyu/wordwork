// @vitest-environment node
/**
 * Live contract test: drives the *shipped* ApiClient against a running server.
 *
 * This is what proves the desktop client's request paths, field names and
 * content types match the real FastAPI service instead of merely rendering.
 * It is skipped unless a server is pointed at:
 *
 *     WORDWORK_LIVE_API=http://127.0.0.1:8000 pnpm test
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiClient, sha256Hex } from '../lib/api';
import { docxBytes } from './docx';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const baseUrl = env.WORDWORK_LIVE_API;
const teacherPassword = env.WORDWORK_LIVE_TEACHER_PASSWORD ?? 'wordwork-demo-change-me';
const memberPassword = 'live-member-password-2026';
const memberChangedPassword = 'live-member-changed-2026';
const suffix = Date.now().toString(36);

const live = Boolean(baseUrl);

let memberPasswordChanged = false;

/**
 * Log in as the live student the way a real one has to.
 *
 * The server returns 428 for every endpoint until a first-login password change is done,
 * so a test that skips this would only prove the enforcement works, not the workflow.
 * The change happens once per run; later logins use the new password.
 */
async function loginStudent(): Promise<ApiClient> {
  const student = new ApiClient(baseUrl as string);
  const session = await student.login(`live_${suffix}`, memberPasswordChanged ? memberChangedPassword : memberPassword);
  student.token = session.access_token;
  if (session.member.must_change_password) {
    await student.changePassword(memberPassword, memberChangedPassword);
    memberPasswordChanged = true;
  }
  return student;
}

describe.skipIf(!live)('真实服务器端到端联调', () => {
  let teacher: ApiClient;
  let projectId = 0;
  let documentId = 0;
  let roundId = 0;
  let baseVersionId = 0;

  beforeAll(async () => {
    teacher = new ApiClient(baseUrl as string);
    const session = await teacher.login('teacher', teacherPassword);
    teacher.token = session.access_token;
    expect(session.member.role).toBe('teacher');
  });

  it('健康检查可达且已安装 DOCX 引擎', async () => {
    const health = await teacher.health();
    expect(health.status).toBe('ok');
    expect(health.engine_available).toBe(true);
  });

  it('老师建项目、加学生、上传文档、发布轮次', async () => {
    const project = await teacher.createProject(`联调项目-${suffix}`);
    projectId = project.id;
    expect(project.id).toBeGreaterThan(0);

    const student = await teacher.addMember(projectId, `live_${suffix}`, memberPassword, 'student');
    expect(student.username).toBe(`live_${suffix}`);

    const base = docxBytes(['第一段。', '第二段。', '第三段。']);
    const uploaded = await teacher.uploadDocument(projectId, 'main.docx', base);
    documentId = uploaded.id;
    expect(uploaded.sha256).toHaveLength(64);
    expect(uploaded.sha256).toBe(await sha256Hex(base));

    const round = await teacher.createRound(projectId, documentId);
    roundId = round.id;
    baseVersionId = round.base_version_id;
    expect((await teacher.publishRound(roundId)).status).toBe('open');

    const detail = await teacher.getRound(roundId);
    expect(detail.project_id).toBe(projectId);
    expect(detail.document_name).toBe('main.docx');
    expect((await teacher.listMembers(projectId)).map((m) => m.username)).toContain(`live_${suffix}`);
    expect((await teacher.listDocuments(projectId)).map((d) => d.id)).toContain(documentId);
    expect((await teacher.listProjects()).some((p) => p.id === projectId)).toBe(true);
  });

  it('学生提交两个段落的修改，老师审阅后发布合并结果', async () => {
    const student = await loginStudent();

    const revised = docxBytes(['第一段。', '第二段已由学生修改。', '第三段已由学生修改。']);
    const submission = await student.submit(roundId, baseVersionId, 'student.docx', revised, '联调提交');
    expect(submission.status).toBe('ready_for_review');
    expect(submission.redline_version_id).toBeGreaterThan(0);

    const diff = await student.getDiff(submission.id);
    expect(diff.hunks.length).toBeGreaterThan(0);
    expect(diff.hunks.map((h) => h.after).join('')).toContain('已由学生修改');
    expect(diff.hunks.every((h) => h.decision === 'pending')).toBe(true);

    const submissions = await student.listSubmissions(roundId);
    expect(submissions.map((s) => s.id)).toContain(submission.id);

    await expect(student.decideHunk(submission.id, diff.hunks[0].id, 'accepted')).rejects.toMatchObject({
      kind: 'forbidden',
    });

    for (const hunk of diff.hunks) {
      const decided = await teacher.decideHunk(submission.id, hunk.id, 'accepted');
      expect(decided.decision).toBe('accepted');
    }
    const finalized = await teacher.finalizeReview(submission.id);
    expect(finalized.status).toBe('reviewed');

    const published = await teacher.publishResult(roundId);
    expect(published.status).toBe('published');
    expect(published.summary_redline_version_id).toBeGreaterThan(0);

    const merged = await teacher.downloadVersion(published.version_id);
    expect(merged.bytes.length).toBeGreaterThan(0);

    const versions = await teacher.listVersions(documentId);
    expect(versions.filter((v) => v.current).map((v) => v.id)).toEqual([published.version_id]);
    expect(versions.map((v) => v.kind)).toEqual(expect.arrayContaining(['redline', 'contribution', 'submission']));

    const detail = await teacher.getVersion(versions[0].id);
    expect(detail.document_id).toBe(documentId);

    const restored = await teacher.restoreVersion(baseVersionId, documentId);
    expect(restored.current_version_id).toBe(baseVersionId);

    await student.addComment(submission.id, '联调评论');
    expect((await teacher.listComments(submission.id)).map((c) => c.body)).toContain('联调评论');
    expect((await teacher.listConflicts(roundId)).length).toBe(0);
    expect((await teacher.listEvents()).length).toBeGreaterThan(0);
  });

  it('学生的越权请求被服务器拒绝', async () => {
    const student = await loginStudent();
    await expect(student.createProject('学生越权项目')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(student.publishRound(roundId)).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(student.publishResult(roundId)).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('错误服务器地址给出中文 network 错误而不是崩溃', async () => {
    const wrong = new ApiClient('http://127.0.0.1:9/wordwork-not-here');
    await expect(wrong.health()).rejects.toMatchObject({ kind: 'network' });
    await expect(wrong.health()).rejects.toThrow(/无法连接服务器/);
  });

  it('退出登录后 token 立即失效', async () => {
    const session = await loginStudent();
    expect((await session.me()).username).toBe(`live_${suffix}`);
    await session.logout();
    await expect(session.me()).rejects.toMatchObject({ kind: 'auth' });
  });
});
