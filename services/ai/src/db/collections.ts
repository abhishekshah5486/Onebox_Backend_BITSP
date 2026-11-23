import type { AiLabelMode, MailCategory } from '@onebox/contracts';
import type { Collection, Db } from 'mongodb';

// How one label takes part in AI sorting. _id is `${userId}:${accountId}:${path}`.
export interface LabelRuleDoc {
  _id: string;
  userId: string;
  accountId: string;
  path: string;
  name: string;
  // Tells the model what belongs under this label, like a tool description.
  description: string;
  mode: AiLabelMode;
  // Matches below this confidence are dropped.
  threshold: number;
  updatedAt: Date;
}

// A user's own take on a built-in category. _id is `${userId}:${category}`.
export interface CategoryRuleDoc {
  _id: string;
  userId: string;
  category: MailCategory;
  // null keeps OneBox's default description.
  description: string | null;
  mode: AiLabelMode;
  updatedAt: Date;
}

export const RESULT_STATUSES = [
  'applied',
  'pending',
  'accepted',
  'rejected',
  'assigned',
  'discarded',
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export interface LabelResult {
  // A built-in category (path is its key) rather than one of the user's labels.
  kind?: 'label' | 'category';
  path: string;
  name: string;
  confidence: number;
  reason: string;
  // applied: AI put it on; pending: waiting for the user; accepted/rejected: their answer;
  // assigned: a label the user chose instead.
  status: ResultStatus;
}

// One email's sorting. _id is the mail service's message id.
export interface ClassificationDoc {
  _id: string;
  userId: string;
  accountId: string;
  threadId: string;
  from: string;
  subject: string;
  receivedAt: Date;
  model: string | null;
  results: LabelResult[];
  // True while any suggestion still waits for the user.
  pending: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// The user's verdicts, kept to teach the model their taste later.
export interface FeedbackDoc {
  userId: string;
  accountId: string;
  messageId: string;
  path: string;
  verdict: 'accepted' | 'rejected' | 'assigned';
  subject: string;
  createdAt: Date;
}

export interface AiCollections {
  labelRules: Collection<LabelRuleDoc>;
  categoryRules: Collection<CategoryRuleDoc>;
  classifications: Collection<ClassificationDoc>;
  feedback: Collection<FeedbackDoc>;
}

export function aiCollections(db: Db): AiCollections {
  return {
    labelRules: db.collection<LabelRuleDoc>('label_rules'),
    categoryRules: db.collection<CategoryRuleDoc>('category_rules'),
    classifications: db.collection<ClassificationDoc>('classifications'),
    feedback: db.collection<FeedbackDoc>('feedback'),
  };
}

export async function ensureIndexes({ labelRules, classifications, feedback }: AiCollections) {
  await Promise.all([
    labelRules.createIndex({ userId: 1, accountId: 1 }),
    classifications.createIndex({ userId: 1, pending: 1, receivedAt: -1 }),
    classifications.createIndex({ userId: 1, threadId: 1 }),
    feedback.createIndex({ userId: 1, accountId: 1, path: 1, createdAt: -1 }),
  ]);
}
