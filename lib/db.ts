/**
 * DB 초기화 레이어 (설계.md §1, §3.3)
 *
 * 2-DB 구조:
 * - content.db: 읽기 전용, 앱 에셋(assets/db/content.db)으로 번들. 첫 실행 또는
 *   번들 content_version이 documentDirectory에 복사된 버전보다 높으면 재복사.
 * - user.db: 읽기/쓰기, documentDirectory에 상주. 앱 업데이트로 절대 덮어쓰지 않음.
 *   §1.3 DDL을 IF NOT EXISTS로 적용.
 *
 * 모듈 싱글턴 + async init 패턴: initDatabases()를 앱 루트(app/_layout.tsx)에서
 * 1회 호출하고, 이후 화면들은 getContentDb()/getUserDb()로 이미 열린 핸들을 받는다.
 */

import { Asset } from 'expo-asset';
import { Directory, File } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';

const CONTENT_DB_FILENAME = 'content.db';
const USER_DB_FILENAME = 'user.db';

let contentDb: SQLite.SQLiteDatabase | null = null;
let userDb: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<void> | null = null;

/** 앱 에셋으로 번들된 더미/실제 content.db. 진짜 콘텐츠가 나오면 이 파일만 교체하면 된다. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contentDbAsset = require('../assets/db/content.db');

/**
 * expo-sqlite가 DB 파일을 찾는 기본 디렉터리(documentDirectory/SQLite, 순수
 * 파일시스템 경로 — `file://` 접두어 없음). content.db 복사 대상도 반드시 이
 * 디렉터리여야 openDatabaseAsync(databaseName)이 그 파일을 찾는다.
 */
function sqliteDirectory(): Directory {
  const dir = new Directory(SQLite.defaultDatabaseDirectory as string);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

/**
 * assets/db/content.db(번들)를 expo-sqlite 기본 디렉터리로 복사한다(§3.3 절차).
 * - 대상 파일이 없으면 무조건 복사.
 * - 있으면 content_meta.content_version을 비교해 번들 쪽이 더 크면 덮어쓰기.
 *   (버전 비교는 숫자 비교. 더미는 "0", 실제 배포본은 "1"부터 시작 — pack_db.py 참고)
 */
async function ensureContentDb(): Promise<SQLite.SQLiteDatabase> {
  const destDir = sqliteDirectory();
  const destFile = new File(destDir, CONTENT_DB_FILENAME);

  const asset = Asset.fromModule(contentDbAsset);
  await asset.downloadAsync();
  if (!asset.localUri) {
    throw new Error('content.db 에셋을 다운로드하지 못했습니다 (localUri 없음)');
  }
  const bundledFile = new File(asset.localUri);

  let shouldCopy = !destFile.exists;

  if (!shouldCopy) {
    try {
      const existingVersion = await readContentVersion(CONTENT_DB_FILENAME);
      const bundledVersion = await readContentVersionFromFile(bundledFile);
      if (bundledVersion > existingVersion) {
        shouldCopy = true;
      }
    } catch {
      // 버전 조회 실패(손상된 파일 등) → 안전하게 재복사
      shouldCopy = true;
    }
  }

  if (shouldCopy) {
    if (destFile.exists) {
      destFile.delete();
    }
    bundledFile.copy(destFile);
  }

  return SQLite.openDatabaseAsync(CONTENT_DB_FILENAME);
}

/** 이미 expo-sqlite 기본 디렉터리에 있는 DB 파일을 이름으로 열어 content_version을 읽는다. */
async function readContentVersion(databaseName: string): Promise<number> {
  const tmpDb = await SQLite.openDatabaseAsync(databaseName);
  try {
    const row = await tmpDb.getFirstAsync<{ value: string }>(
      "SELECT value FROM content_meta WHERE key = 'content_version'",
    );
    return row ? Number(row.value) : -1;
  } finally {
    await tmpDb.closeAsync();
  }
}

/**
 * 아직 SQLite 기본 디렉터리에 있지 않은 파일(예: 다운로드 직후의 번들 에셋)의
 * content_version을 읽기 위해, 그 파일이 있는 디렉터리를 임시로 지정해 연다.
 */
async function readContentVersionFromFile(file: File): Promise<number> {
  const parentPath = file.uri.replace(/^file:\/\//, '').replace(/\/[^/]+$/, '');
  const tmpDb = await SQLite.openDatabaseAsync(file.name, undefined, parentPath);
  try {
    const row = await tmpDb.getFirstAsync<{ value: string }>(
      "SELECT value FROM content_meta WHERE key = 'content_version'",
    );
    return row ? Number(row.value) : -1;
  } finally {
    await tmpDb.closeAsync();
  }
}

const USER_DB_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  level             INTEGER NOT NULL DEFAULT 1,
  words_per_day     INTEGER NOT NULL DEFAULT 20
);

CREATE TABLE IF NOT EXISTS income_rule (
  id          INTEGER PRIMARY KEY,
  min_score   INTEGER NOT NULL,
  amount      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS day (
  id           INTEGER PRIMARY KEY,
  day_index    INTEGER NOT NULL UNIQUE,
  created_day  INTEGER NOT NULL,
  created_ms   INTEGER NOT NULL,
  is_started   INTEGER NOT NULL DEFAULT 0,
  words_count  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_day_created ON day(created_day);

CREATE TABLE IF NOT EXISTS day_word (
  id               INTEGER PRIMARY KEY,
  day_id           INTEGER NOT NULL REFERENCES day(id) ON DELETE CASCADE,
  content_word_id  INTEGER NOT NULL,
  position         INTEGER NOT NULL,
  recall_stage     INTEGER NOT NULL DEFAULT 0,
  UNIQUE(content_word_id),
  UNIQUE(day_id, position)
);
CREATE INDEX IF NOT EXISTS idx_dayword_day ON day_word(day_id);

CREATE TABLE IF NOT EXISTS test_session (
  id            INTEGER PRIMARY KEY,
  day_id        INTEGER NOT NULL REFERENCES day(id),
  taken_day     INTEGER NOT NULL,
  taken_ms      INTEGER NOT NULL,
  total_count   INTEGER NOT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0,
  score100      INTEGER,
  income_amount INTEGER,
  paid          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_session_takenday ON test_session(taken_day);
CREATE INDEX IF NOT EXISTS idx_session_takenms  ON test_session(taken_ms);

CREATE TABLE IF NOT EXISTS test_item (
  id               INTEGER PRIMARY KEY,
  session_id       INTEGER NOT NULL REFERENCES test_session(id) ON DELETE CASCADE,
  content_word_id  INTEGER NOT NULL,
  is_wrong         INTEGER NOT NULL DEFAULT 0,
  pron_confused    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_testitem_session ON test_item(session_id);
CREATE INDEX IF NOT EXISTS idx_testitem_word    ON test_item(content_word_id);
CREATE INDEX IF NOT EXISTS idx_testitem_wrong   ON test_item(content_word_id) WHERE is_wrong = 1;

-- 하루 4회 분산 인출 로그 (설계.md §7.2). 하나의 확정된 인출 세션 = 1행.
-- UNIQUE(local_day, slot_index)가 "슬롯당 1회"를 DB 차원에서 물리 보장(§7.1).
CREATE TABLE IF NOT EXISTS retrieval_session (
  id          INTEGER PRIMARY KEY,
  local_day   INTEGER NOT NULL,              -- epoch day(로컬 자정 기준, §1.4). 스트릭·게이지 조회 키
  slot_index  INTEGER NOT NULL,              -- 0..3 (설정된 슬롯 순서). 데드존은 기록 안 함
  source      TEXT NOT NULL DEFAULT 'today', -- 'today'(오늘 단어장) | 'review'(복습) — 확장 여지(§7.6)
  day_id      INTEGER REFERENCES day(id) ON DELETE SET NULL, -- 어느 Day를 훑었는지(감사용)
  done_ms     INTEGER NOT NULL,              -- 확정 시각 epoch ms
  UNIQUE(local_day, slot_index)              -- ★ 슬롯당 1회 인정(핵심 제약)
);
CREATE INDEX IF NOT EXISTS idx_retrieval_day ON retrieval_session(local_day);

-- 슬롯 경계 설정(4행 고정, slot_index 0..3, 설계.md §7.2).
CREATE TABLE IF NOT EXISTS slot_config (
  slot_index  INTEGER PRIMARY KEY CHECK (slot_index BETWEEN 0 AND 3),
  start_hour  INTEGER NOT NULL CHECK (start_hour BETWEEN 0 AND 23),
  end_hour    INTEGER NOT NULL CHECK (end_hour BETWEEN 1 AND 24),  -- 24 = 자정
  CHECK (start_hour < end_hour)
);

-- 습관 보너스 지급 스냅샷(§7.4). 시험 점수와 무관하므로 test_session에 섞지 않는다.
CREATE TABLE IF NOT EXISTS habit_bonus (
  id         INTEGER PRIMARY KEY,
  local_day  INTEGER NOT NULL,
  kind       TEXT NOT NULL,                  -- 'full_day' | 'streak7'
  amount     INTEGER NOT NULL,               -- 지급 시점 스냅샷(상수가 바뀌어도 소급 안 함)
  paid       INTEGER NOT NULL DEFAULT 0,     -- 부모 지급 체크(test_session.paid와 동일 개념)
  created_ms INTEGER NOT NULL,
  UNIQUE(local_day, kind)                    -- 하루 같은 종류 보너스 중복 지급 방지(멱등)
);
`;

/** slot_config 기본 4행 시드값 (설계.md §7.2): (0,6,10)(1,10,15)(2,15,20)(3,20,24). */
const DEFAULT_SLOT_CONFIG: ReadonlyArray<{ slot_index: number; start_hour: number; end_hour: number }> = [
  { slot_index: 0, start_hour: 6, end_hour: 10 },
  { slot_index: 1, start_hour: 10, end_hour: 15 },
  { slot_index: 2, start_hour: 15, end_hour: 20 },
  { slot_index: 3, start_hour: 20, end_hour: 24 },
];

/**
 * slot_config lazy seed (ensureIncomeRules()와 동일 패턴, 설계.md §7.2 마이그레이션 절차 2).
 * COUNT(*)=0일 때만 기본 4행을 트랜잭션으로 채운다. 이미 행이 있으면(사용자가 설정에서
 * 편집한 경우 포함) 아무 것도 하지 않는다.
 */
async function ensureSlotConfig(db: SQLite.SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM slot_config');
  if (row && row.cnt > 0) return;

  await db.withTransactionAsync(async () => {
    for (const slot of DEFAULT_SLOT_CONFIG) {
      await db.runAsync(
        'INSERT INTO slot_config (slot_index, start_hour, end_hour) VALUES (?, ?, ?)',
        [slot.slot_index, slot.start_hour, slot.end_hour],
      );
    }
  });
}

async function ensureUserDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(USER_DB_FILENAME);
  await db.execAsync(USER_DB_DDL);

  // settings 기본행 보장 (§1.3: id=1 고정 단일 행)
  await db.runAsync(
    'INSERT OR IGNORE INTO settings (id, level, words_per_day) VALUES (1, 1, 20)',
  );

  // slot_config 기본 4행 보장 (§7.2)
  await ensureSlotConfig(db);

  // app_meta 스키마 버전 기록 (신규 설치는 '2'로 seed)
  await db.runAsync(
    "INSERT OR IGNORE INTO app_meta (key, value) VALUES ('user_schema_version', '2')",
  );
  // 기존 설치(버전 '1')는 INSERT OR IGNORE로 올라가지 않으므로 명시적으로 갱신 (§7.2 마이그레이션 절차 3)
  await db.runAsync("UPDATE app_meta SET value = '2' WHERE key = 'user_schema_version'");

  return db;
}

/**
 * 앱 시작 시 1회 호출. content.db 탑재 + user.db 오픈/마이그레이션을 완료한다.
 * 중복 호출 시 진행 중인 초기화를 그대로 재사용한다(idempotent).
 */
export function initDatabases(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const [content, user] = await Promise.all([ensureContentDb(), ensureUserDb()]);
    contentDb = content;
    userDb = user;
  })();

  return initPromise;
}

/** 초기화 완료 후에만 유효한 핸들 getter. init 전에 호출하면 에러를 던진다(호출부 실수 방지). */
export function getContentDb(): SQLite.SQLiteDatabase {
  if (!contentDb) {
    throw new Error('content.db가 아직 초기화되지 않았습니다. initDatabases()를 먼저 호출하세요.');
  }
  return contentDb;
}

export function getUserDb(): SQLite.SQLiteDatabase {
  if (!userDb) {
    throw new Error('user.db가 아직 초기화되지 않았습니다. initDatabases()를 먼저 호출하세요.');
  }
  return userDb;
}
