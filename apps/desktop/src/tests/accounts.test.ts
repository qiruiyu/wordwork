import { describe, expect, it } from 'vitest';

import {
  STATE_VERSION,
  accountKey,
  bucketOf,
  emptyState,
  migrateState,
  normalizeServerUrl,
  queueFor,
  totalOrphaned,
  withBucket,
  workingCopiesFor,
  type BucketedState,
} from '../lib/accounts';
import type { QueuedSubmission, WorkingCopy } from '../types';

const SERVER = 'http://192.168.1.10:8443';
const OTHER_SERVER = 'http://10.0.0.5:8443';

function copy(over: Partial<WorkingCopy> = {}): WorkingCopy {
  return {
    projectId: 1,
    projectName: '基金申请',
    roundId: 3,
    roundNumber: 1,
    documentId: 4,
    baseVersionId: 19,
    baseVersionName: 'main.docx',
    localPath: 'C:\\Users\\lab\\Desktop\\studentB_round1.docx',
    sha256: 'a'.repeat(64),
    updatedAt: '2026-09-13T10:00:00.000Z',
    ...over,
  };
}

function queued(owner: string, over: Partial<QueuedSubmission> = {}): QueuedSubmission {
  return {
    id: 'q-1',
    owner,
    roundId: 3,
    baseVersionId: 19,
    note: '离线提交',
    snapshotPath: `C:\\snapshots\\${owner}\\abc.docx`,
    localPath: 'studentB_round1.docx',
    sha256: 'b'.repeat(64),
    attempts: 1,
    createdAt: '2026-09-13T10:00:00.000Z',
    ...over,
  };
}

describe('账号桶的键', () => {
  it('规范化服务器地址，忽略结尾斜杠和大小写', () => {
    expect(normalizeServerUrl('  http://Host:8000/  ')).toBe('http://host:8000');
    expect(accountKey('http://Host:8000/', 7)).toBe(accountKey('http://host:8000', 7));
  });

  it('按成员 id 分开，而不是按用户名', () => {
    // Two accounts can share a username across servers, and a username can be reused;
    // `member.id` is what the API actually authenticates.
    expect(accountKey(SERVER, 1)).not.toBe(accountKey(SERVER, 2));
    expect(accountKey(SERVER, 1)).toBe(accountKey(SERVER, 1));
  });

  it('按服务器地址分开', () => {
    expect(accountKey(SERVER, 1)).not.toBe(accountKey(OTHER_SERVER, 1));
  });

  it('没有账号或没有服务器时拒绝给出键，避免把数据存到一个共享的桶里', () => {
    expect(accountKey(SERVER, null)).toBeNull();
    expect(accountKey(SERVER, undefined)).toBeNull();
    expect(accountKey(SERVER, 0)).toBeNull();
    expect(accountKey(SERVER, Number.NaN)).toBeNull();
    expect(accountKey('', 1)).toBeNull();
    expect(accountKey('   ', 1)).toBeNull();
  });

  it('生成的键可以直接当文件夹名用', () => {
    expect(accountKey(SERVER, 12)).toMatch(/^[a-z0-9_]+-m12$/);
  });
});

describe('桶的读写', () => {
  it('读不到自己的桶时返回空数组，绝不回落到别人的数据', () => {
    const buckets = withBucket(undefined, 'server-m1', [copy()]);
    expect(bucketOf(buckets, 'server-m1')).toHaveLength(1);
    expect(bucketOf(buckets, 'server-m2')).toEqual([]);
    expect(bucketOf(buckets, null)).toEqual([]);
    expect(bucketOf(undefined, 'server-m1')).toEqual([]);
  });

  it('写入不修改原来的对象', () => {
    const before = withBucket(undefined, 'server-m1', [copy()]);
    const after = withBucket(before, 'server-m2', [copy({ localPath: 'C:\\b.docx' })]);
    expect(Object.keys(before)).toEqual(['server-m1']);
    expect(before['server-m1']).toHaveLength(1);
    expect(after['server-m2']).toHaveLength(1);
  });
});

describe('迁移旧状态', () => {
  it('v1 的全局工作副本被隔离，不会自动归给登录的人', () => {
    // The persisted session is the *last* login, not the author. Handing the list to
    // it is exactly the bug being fixed (student C seeing studentB_round1.docx).
    const legacy = {
      version: 1,
      serverUrl: SERVER,
      session: { token: 't', member: { id: 9, username: 'studentC', role: 'student' } },
      workingCopies: [copy()],
      queue: [queued('legacy')],
    };

    const migrated = migrateState(legacy);

    expect(migrated.version).toBe(STATE_VERSION);
    expect(migrated.workingCopies).toEqual({});
    expect(migrated.queue).toEqual({});
    expect(totalOrphaned(migrated.orphaned)).toBe(2);
    // The signed-in member must not be able to see or upload any of it.
    const key = accountKey(migrated.serverUrl, migrated.session?.member.id ?? null);
    expect(workingCopiesFor(migrated, key)).toEqual([]);
    expect(queueFor(migrated, key)).toEqual([]);
    // The session itself survives, so the user is not logged out.
    expect(migrated.session?.member.username).toBe('studentC');
  });

  it('v1 里的队列连 owner 都没有，仍然只进隔离区', () => {
    const migrated = migrateState({ version: 1, workingCopies: [], queue: [{ roundId: 1 }] });
    expect(migrated.queue).toEqual({});
    expect(migrated.orphaned.queue).toHaveLength(1);
  });

  it('v2 的桶和隔离区原样保留', () => {
    const key = accountKey(SERVER, 7) as string;
    const state: BucketedState = {
      ...emptyState(),
      serverUrl: SERVER,
      workingCopies: withBucket(undefined, key, [copy()]),
      queue: withBucket(undefined, key, [queued(key)]),
      orphaned: { workingCopies: [copy({ localPath: 'C:\\old.docx' })], queue: [] },
    };

    const migrated = migrateState(state);

    expect(workingCopiesFor(migrated, key)).toHaveLength(1);
    expect(queueFor(migrated, key)).toHaveLength(1);
    expect(totalOrphaned(migrated.orphaned)).toBe(1);
  });

  it('无法识别的状态一律变成干净的空状态', () => {
    for (const raw of [null, undefined, 'nonsense', 42, {}, { version: 3 }, { version: '2' }]) {
      expect(migrateState(raw)).toEqual(emptyState());
    }
  });
});

describe('一台共享电脑上三个账号轮流登录', () => {
  const state = (): BucketedState => ({
    ...emptyState(),
    serverUrl: SERVER,
    workingCopies: {},
    queue: {},
    orphaned: { workingCopies: [], queue: [] },
  });

  it('A 的副本和离线项对 B、C 不可见，A 再登录时还在', () => {
    const a = accountKey(SERVER, 1) as string;
    const b = accountKey(SERVER, 2) as string;
    const c = accountKey(SERVER, 3) as string;

    let current = state();
    current = { ...current, workingCopies: withBucket(current.workingCopies, a, [copy()]) };
    current = { ...current, queue: withBucket(current.queue, a, [queued(a)]) };

    expect(workingCopiesFor(current, b)).toEqual([]);
    expect(queueFor(current, b)).toEqual([]);
    expect(workingCopiesFor(current, c)).toEqual([]);
    expect(queueFor(current, c)).toEqual([]);
    // Nothing a B/C session can reach contains A's filename.
    expect(JSON.stringify([workingCopiesFor(current, b), queueFor(current, c)])).not.toContain('studentB_round1');

    expect(workingCopiesFor(current, a)).toHaveLength(1);
    expect(queueFor(current, a)).toHaveLength(1);
  });

  it('换服务器时也不会串用', () => {
    const here = accountKey(SERVER, 1) as string;
    const elsewhere = accountKey(OTHER_SERVER, 1) as string;
    const current: BucketedState = { ...state(), workingCopies: withBucket(undefined, here, [copy()]) };
    expect(workingCopiesFor(current, elsewhere)).toEqual([]);
  });
});
