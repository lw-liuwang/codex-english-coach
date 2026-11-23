import { z } from 'zod';

export const PRODUCT = 'codex-english-coach';
export const VERSION = '0.1.0';
export const PROTOCOL_VERSION = 1;
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const INTERVALS = [1, 3, 7, 14, 30, 60] as const;
export const SourceSchema = z.enum(['writing', 'reading']);
export const KindSchema = z.enum(['word', 'phrase', 'sentence']);
export const RatingSchema = z.enum(['forgot', 'hard', 'familiar']);
const text = z.string().trim().min(1).max(12000);

export const LearningPointSchema = z.object({
  kind: KindSchema,
  expression: text.describe('Correct English word, phrase, or sentence; use the canonical form.'),
  meaning: text.describe('A concise Chinese sense label; keep distinct meanings separate.'),
  context: text.describe('Only the sentence needed to understand this use, not the full conversation.'),
  explanation: text.describe('Chinese explanation of the vocabulary or correction.'),
  original: z.string().max(12000).default('').describe('Only the original fragment being corrected, if any.'),
  prompt: text.describe('Writing: Chinese intent or a cloze with the answer hidden. Reading: English context to interpret.')
}).strict();

const CaptureObjectSchema = z.object({
  id: z.string().uuid(),
  source: SourceSchema,
  sourceLabel: z.string().trim().max(300).default('Codex'),
  points: z.array(LearningPointSchema).min(1).max(50)
}).strict();
function withinCaptureLimit(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_CAPTURE_BYTES;
}
export const CaptureInputSchema = CaptureObjectSchema.refine(withinCaptureLimit, 'A capture must fit within 2 MiB of UTF-8 JSON.');
export const CaptureToolInputSchema = CaptureObjectSchema.extend({ id: z.string().uuid().optional() })
  .refine(withinCaptureLimit, 'A capture must fit within 2 MiB of UTF-8 JSON.');
export const ReviewInputSchema = z.object({
  id: z.string().uuid(), cardId: z.string().uuid(), rating: RatingSchema
}).strict();
export const CardPatchSchema = z.object({
  meaning: text.optional(), explanation: text.optional(), prompt: text.optional(), archived: z.boolean().optional()
}).strict().refine(value => Object.keys(value).length > 0, 'At least one field is required');

export type Source = z.infer<typeof SourceSchema>;
export type Kind = z.infer<typeof KindSchema>;
export type Rating = z.infer<typeof RatingSchema>;
export type LearningPoint = z.infer<typeof LearningPointSchema>;
export type CaptureInput = z.infer<typeof CaptureInputSchema>;
export type CaptureToolInput = z.input<typeof CaptureToolInputSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export type CardPatch = z.infer<typeof CardPatchSchema>;

export interface Card extends LearningPoint {
  id: string;
  source: Source;
  archived: boolean;
  step: number;
  dueDate: string;
  lastPromotedDate: string | null;
  createdAt: string;
  updatedAt: string;
  lastEncounterAt: string;
  encounters: number;
}
export interface Encounter {
  id: string; cardId: string; captureId: string; sourceLabel: string;
  context: string; explanation: string; original: string; createdAt: string;
}
export interface Review {
  id: string; cardId: string; rating: Rating; reviewedAt: string;
  previousStep: number; nextStep: number; nextDueDate: string;
}
export interface CardDetail { card: Card; encounters: Encounter[]; reviews: Review[] }
export interface CardList { items: Card[]; total: number }
export interface Stats { total: number; writing: number; reading: number; due: number; archived: number; pending: number }
export interface CaptureResult { id: string; status: 'saved'; created: number; matched: number; replayed: boolean }
export interface ReviewResult { review: Review; card: Card; replayed: boolean }
export interface Health { product: typeof PRODUCT; protocolVersion: number; version: string; status: 'ok'; pid: number; instanceId: string; dataDir: string }

export function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function nextSchedule(card: Pick<Card, 'step' | 'lastPromotedDate'>, rating: Rating, today: string) {
  let step = card.step;
  let lastPromotedDate = card.lastPromotedDate;
  if (rating === 'forgot') step = 0;
  if (rating === 'hard') step = Math.max(0, step - 1);
  if (rating === 'familiar' && lastPromotedDate !== today) {
    step = Math.min(INTERVALS.length - 1, step + 1);
    lastPromotedDate = today;
  }
  return { step, lastPromotedDate, dueDate: addDays(today, INTERVALS[step]!) };
}
