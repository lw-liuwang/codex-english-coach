import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  addDays, nextSchedule, shanghaiDate,
  type Card, type CardDetail, type CardPatch, type CaptureInput, type CaptureResult,
  type Encounter, type Kind, type Review, type ReviewInput, type ReviewResult, type Source, type Stats
} from '@english-coach/shared';

export class StoreError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

interface CardRow {
  id: string; source: Source; kind: Kind; expression: string; meaning: string; context: string;
  explanation: string; original: string; prompt: string; archived: number; step: number;
  due_date: string; last_promoted_date: string | null; created_at: string; updated_at: string;
  last_encounter_at: string; encounter_count: number;
}
interface ReviewRow {
  id: string; card_id: string; rating: Review['rating']; reviewed_at: string;
  previous_step: number; next_step: number; next_due_date: string;
}
export interface CardFilters {
  q?: string; source?: Source; kind?: Kind; from?: string; to?: string;
  archived?: boolean; limit?: number; offset?: number;
}

function cardFromRow(row: CardRow): Card {
  return {
    id: row.id, source: row.source, kind: row.kind, expression: row.expression,
    meaning: row.meaning, context: row.context, explanation: row.explanation,
    original: row.original, prompt: row.prompt, archived: row.archived === 1,
    step: row.step, dueDate: row.due_date, lastPromotedDate: row.last_promoted_date,
    createdAt: row.created_at, updatedAt: row.updated_at,
    lastEncounterAt: row.last_encounter_at, encounters: row.encounter_count
  };
}
function reviewFromRow(row: ReviewRow): Review {
  return {
    id: row.id, cardId: row.card_id, rating: row.rating, reviewedAt: row.reviewed_at,
    previousStep: row.previous_step, nextStep: row.next_step, nextDueDate: row.next_due_date
  };
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function normalize(value: string) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase(); }
function cardKey(source: Source, kind: Kind, expression: string, meaning: string) {
  return hash(JSON.stringify([source, kind, normalize(expression), normalize(meaning)]));
}

export class LearningStore {
  readonly db: DatabaseSync;
  constructor(readonly dataDir: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'learning.sqlite'));
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) {
      this.db.close();
      throw new Error('数据库版本高于当前程序，请先更新程序。');
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL, result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('writing','reading')),
        kind TEXT NOT NULL CHECK (kind IN ('word','phrase','sentence')),
        expression TEXT NOT NULL, meaning TEXT NOT NULL, context TEXT NOT NULL,
        explanation TEXT NOT NULL, original TEXT NOT NULL, prompt TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
        step INTEGER NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 5),
        due_date TEXT NOT NULL, last_promoted_date TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_encounter_at TEXT NOT NULL,
        encounter_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS encounters (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), capture_id TEXT NOT NULL REFERENCES captures(id),
        source_label TEXT NOT NULL, context TEXT NOT NULL, explanation TEXT NOT NULL,
        original TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id),
        rating TEXT NOT NULL CHECK (rating IN ('forgot','hard','familiar')),
        reviewed_at TEXT NOT NULL, previous_step INTEGER NOT NULL,
        next_step INTEGER NOT NULL, next_due_date TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cards_due ON cards(archived, due_date);
      CREATE INDEX IF NOT EXISTS encounters_card ON encounters(card_id, created_at);
      CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id, reviewed_at);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }

  close() { this.db.close(); }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  capture(input: CaptureInput): CaptureResult {
    return this.transaction(() => {
      const payloadHash = hash(JSON.stringify(input));
      const existing = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(input.id) as
        { payload_hash: string; result_json: string } | undefined;
      if (existing) {
        if (existing.payload_hash !== payloadHash) throw new StoreError(409, '该记录编号已用于不同内容。');
        return { ...JSON.parse(existing.result_json) as CaptureResult, replayed: true };
      }
      const now = this.now();
      const timestamp = now.toISOString();
      const result: CaptureResult = { id: input.id, status: 'saved', created: 0, matched: 0, replayed: false };
      this.db.prepare('INSERT INTO captures VALUES (?, ?, ?, ?)').run(input.id, payloadHash, timestamp, '{}');
      for (const point of input.points) {
        const key = cardKey(input.source, point.kind, point.expression, point.meaning);
        const found = this.db.prepare('SELECT id FROM cards WHERE dedupe_key = ?').get(key) as { id: string } | undefined;
        const id = found?.id ?? randomUUID();
        if (!found) {
          this.db.prepare(`INSERT INTO cards (
            id, dedupe_key, source, kind, expression, meaning, context, explanation, original, prompt,
            due_date, created_at, updated_at, last_encounter_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            id, key, input.source, point.kind, point.expression, point.meaning, point.context,
            point.explanation, point.original, point.prompt, addDays(shanghaiDate(now), 1), timestamp, timestamp, timestamp
          );
          result.created++;
        } else result.matched++;
        this.db.prepare(`INSERT INTO encounters
          (id, card_id, capture_id, source_label, context, explanation, original, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), id, input.id, input.sourceLabel, point.context, point.explanation, point.original, timestamp
        );
        this.db.prepare('UPDATE cards SET encounter_count = encounter_count + 1, last_encounter_at = ?, updated_at = ? WHERE id = ?')
          .run(timestamp, timestamp, id);
      }
      this.db.prepare('UPDATE captures SET result_json = ? WHERE id = ?').run(JSON.stringify(result), input.id);
      return result;
    });
  }

  card(id: string): Card {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined;
    if (!row) throw new StoreError(404, '未找到这张卡片。');
    return cardFromRow(row);
  }

  list(filters: CardFilters = {}) {
    const clauses = ['archived = ?'];
    const params: (string | number)[] = [filters.archived ? 1 : 0];
    if (filters.source) { clauses.push('source = ?'); params.push(filters.source); }
    if (filters.kind) { clauses.push('kind = ?'); params.push(filters.kind); }
    if (filters.from) { clauses.push("date(created_at,'+8 hours') >= ?"); params.push(filters.from); }
    if (filters.to) { clauses.push("date(created_at,'+8 hours') <= ?"); params.push(filters.to); }
    if (filters.q) {
      const search = `%${filters.q.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push("(expression LIKE ? ESCAPE '\\' OR meaning LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\' OR explanation LIKE ? ESCAPE '\\' OR original LIKE ? ESCAPE '\\')");
      params.push(search, search, search, search, search);
    }
    const where = clauses.join(' AND ');
    const count = this.db.prepare(`SELECT COUNT(*) AS total FROM cards WHERE ${where}`).get(...params) as { total: number };
    const rows = this.db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY last_encounter_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, filters.limit ?? 50, filters.offset ?? 0) as unknown as CardRow[];
    return { items: rows.map(cardFromRow), total: count.total };
  }

  detail(id: string): CardDetail {
    const card = this.card(id);
    const encounters = this.db.prepare(`SELECT id, card_id AS cardId, capture_id AS captureId,
      source_label AS sourceLabel, context, explanation, original, created_at AS createdAt
      FROM encounters WHERE card_id = ? ORDER BY created_at DESC, rowid DESC`).all(id) as unknown as Encounter[];
    const reviews = (this.db.prepare('SELECT * FROM reviews WHERE card_id = ? ORDER BY reviewed_at DESC, rowid DESC')
      .all(id) as unknown as ReviewRow[]).map(reviewFromRow);
    return { card, encounters, reviews };
  }

  patch(id: string, patch: CardPatch): Card {
    return this.transaction(() => {
      const card = this.card(id);
      const updated = { ...card, ...patch };
      const key = cardKey(card.source, card.kind, card.expression, updated.meaning);
      const conflict = this.db.prepare('SELECT id FROM cards WHERE dedupe_key = ? AND id != ?').get(key, id);
      if (conflict) throw new StoreError(409, '已有相同表达、义项和方向的卡片，请保留为不同义项或归档其中一张。');
      this.db.prepare('UPDATE cards SET dedupe_key = ?, meaning = ?, explanation = ?, prompt = ?, archived = ?, updated_at = ? WHERE id = ?')
        .run(key, updated.meaning, updated.explanation, updated.prompt, updated.archived ? 1 : 0, this.now().toISOString(), id);
      return this.card(id);
    });
  }

  queue(limit = 10, source?: Source) {
    const params: (string | number)[] = [shanghaiDate(this.now())];
    const where = `archived = 0 AND due_date <= ?${source ? ' AND source = ?' : ''}`;
    if (source) params.push(source);
    const count = this.db.prepare(`SELECT COUNT(*) AS total FROM cards WHERE ${where}`).get(...params) as { total: number };
    const rows = this.db.prepare(`SELECT * FROM cards WHERE ${where} ORDER BY due_date, created_at, id LIMIT ?`)
      .all(...params, limit) as unknown as CardRow[];
    return { items: rows.map(cardFromRow), total: count.total };
  }

  review(input: ReviewInput): ReviewResult {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(input.id) as ReviewRow | undefined;
      if (existing) {
        if (existing.card_id !== input.cardId || existing.rating !== input.rating) throw new StoreError(409, '该评分编号已用于其他评分。');
        return { review: reviewFromRow(existing), card: this.card(input.cardId), replayed: true };
      }
      const card = this.card(input.cardId);
      const now = this.now();
      const today = shanghaiDate(now);
      if (card.archived) throw new StoreError(409, '这张卡片已归档。');
      if (card.dueDate > today) throw new StoreError(409, '这张卡片已完成评分或尚未到复习日期，请刷新队列。');
      const schedule = nextSchedule(card, input.rating, today);
      const reviewedAt = now.toISOString();
      this.db.prepare(`INSERT INTO reviews
        (id, card_id, rating, reviewed_at, previous_step, next_step, next_due_date) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, card.id, input.rating, reviewedAt, card.step, schedule.step, schedule.dueDate);
      this.db.prepare('UPDATE cards SET step = ?, due_date = ?, last_promoted_date = ?, updated_at = ? WHERE id = ?')
        .run(schedule.step, schedule.dueDate, schedule.lastPromotedDate, reviewedAt, card.id);
      return {
        review: { id: input.id, cardId: card.id, rating: input.rating, reviewedAt,
          previousStep: card.step, nextStep: schedule.step, nextDueDate: schedule.dueDate },
        card: this.card(card.id), replayed: false
      };
    });
  }

  stats(pending = 0): Stats {
    const result = this.db.prepare(`SELECT
      COUNT(CASE WHEN archived = 0 THEN 1 END) AS total,
      COUNT(CASE WHEN archived = 0 AND source = 'writing' THEN 1 END) AS writing,
      COUNT(CASE WHEN archived = 0 AND source = 'reading' THEN 1 END) AS reading,
      COUNT(CASE WHEN archived = 0 AND due_date <= ? THEN 1 END) AS due,
      COUNT(CASE WHEN archived = 1 THEN 1 END) AS archived FROM cards`).get(shanghaiDate(this.now())) as Omit<Stats, 'pending'>;
    return { ...result, pending };
  }

  exportData() {
    return { product: 'codex-english-coach', schemaVersion: 1, exportedAt: this.now().toISOString(),
      cards: (this.db.prepare('SELECT * FROM cards ORDER BY created_at').all() as unknown as CardRow[]).map(cardFromRow),
      encounters: this.db.prepare('SELECT * FROM encounters ORDER BY created_at').all(),
      reviews: (this.db.prepare('SELECT * FROM reviews ORDER BY reviewed_at').all() as unknown as ReviewRow[]).map(reviewFromRow)
    };
  }

  async backup(): Promise<string> {
    const directory = join(this.dataDir, 'backups');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `learning-${this.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.sqlite`);
    await backup(this.db, path);
    return path;
  }
}
