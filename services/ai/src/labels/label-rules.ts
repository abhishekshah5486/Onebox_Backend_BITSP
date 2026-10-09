import type { AiLabelMode } from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { AiCollections, LabelRuleDoc } from '../db/collections';

export const DEFAULT_THRESHOLD = 0.6;
const MIN_DESCRIPTION = 10;

const idOf = (userId: string, accountId: string, path: string) => `${userId}:${accountId}:${path}`;

export interface LabelRuleInput {
  accountId: string;
  path: string;
  name: string;
  description: string;
  mode: AiLabelMode;
  threshold?: number | undefined;
}

// Each label's description and how AI may use it.
export function createLabelRules({ labelRules }: AiCollections) {
  const view = (rule: LabelRuleDoc) => ({
    accountId: rule.accountId,
    path: rule.path,
    name: rule.name,
    description: rule.description,
    mode: rule.mode,
    threshold: rule.threshold,
  });

  return {
    async list(userId: string, accountId?: string) {
      const rules = await labelRules
        .find({ userId, ...(accountId && { accountId }) })
        .sort({ accountId: 1, path: 1 })
        .toArray();
      return rules.map(view);
    },

    async save(userId: string, input: LabelRuleInput) {
      const description = input.description.trim();
      if (input.mode !== 'off' && description.length < MIN_DESCRIPTION) {
        throw new ValidationError(
          'Describe what belongs under this label (at least 10 characters) so AI can use it.',
        );
      }
      const rule: LabelRuleDoc = {
        _id: idOf(userId, input.accountId, input.path),
        userId,
        accountId: input.accountId,
        path: input.path,
        name: input.name,
        description,
        mode: input.mode,
        threshold: input.threshold ?? DEFAULT_THRESHOLD,
        updatedAt: new Date(),
      };
      await labelRules.replaceOne({ _id: rule._id }, rule, { upsert: true });
      return view(rule);
    },

    // Keeps a label's description when it is renamed on the server.
    async move(userId: string, accountId: string, from: string, to: string, name: string) {
      const rule = await labelRules.findOne({ _id: idOf(userId, accountId, from) });
      if (!rule) return;
      const { _id: old, ...rest } = rule;
      await labelRules.deleteOne({ _id: old });
      await labelRules.replaceOne(
        { _id: idOf(userId, accountId, to) },
        { ...rest, path: to, name, updatedAt: new Date() },
        { upsert: true },
      );
    },

    async remove(userId: string, accountId: string, path: string) {
      await labelRules.deleteOne({ _id: idOf(userId, accountId, path) });
    },
  };
}

export type LabelRules = ReturnType<typeof createLabelRules>;
