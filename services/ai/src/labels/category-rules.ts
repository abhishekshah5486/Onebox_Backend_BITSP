import {
  MAIL_CATEGORIES,
  MAIL_CATEGORY_DESCRIPTIONS,
  MAIL_CATEGORY_NAMES,
  type AiLabelMode,
  type MailCategory,
} from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { AiCollections, LabelResult } from '../db/collections';

const MIN_DESCRIPTION = 10;

// The categories a message ends up with: put on by AI, or suggested and accepted.
export const categoriesIn = (results: LabelResult[]) =>
  results
    .filter((r) => r.kind === 'category' && (r.status === 'applied' || r.status === 'accepted'))
    .map((r) => r.path as MailCategory);

export interface CategoryRuleInput {
  // null puts the default description back.
  description?: string | null | undefined;
  mode?: AiLabelMode | undefined;
}

// The built-in categories every user starts with, applied by AI with OneBox's descriptions; they
// can reword them, or have AI only suggest them, or leave them to Gmail and themselves.
export function createCategoryRules({ categoryRules }: AiCollections) {
  const idOf = (userId: string, category: MailCategory) => `${userId}:${category}`;

  async function list(userId: string) {
    const saved = new Map(
      (await categoryRules.find({ userId }).toArray()).map((rule) => [rule.category, rule]),
    );
    return MAIL_CATEGORIES.map((category) => {
      const rule = saved.get(category);
      const defaultDescription = MAIL_CATEGORY_DESCRIPTIONS[category];
      return {
        category,
        name: MAIL_CATEGORY_NAMES[category],
        description: rule?.description ?? defaultDescription,
        defaultDescription,
        customized: Boolean(rule?.description),
        mode: rule?.mode ?? 'auto',
      };
    });
  }

  return {
    list,

    async save(userId: string, category: MailCategory, input: CategoryRuleInput) {
      const description = input.description?.trim();
      if (description !== undefined && description.length < MIN_DESCRIPTION) {
        throw new ValidationError(
          'Describe what belongs in this category (at least 10 characters) so AI can use it.',
        );
      }
      const current = (await list(userId)).find((rule) => rule.category === category)!;
      await categoryRules.replaceOne(
        { _id: idOf(userId, category) },
        {
          userId,
          category,
          description:
            input.description === undefined
              ? current.customized
                ? current.description
                : null
              : description === current.defaultDescription
                ? null
                : (description ?? null),
          mode: input.mode ?? current.mode,
          updatedAt: new Date(),
        },
        { upsert: true },
      );
      return (await list(userId)).find((rule) => rule.category === category)!;
    },

    // What the classifier sorts into.
    async active(userId: string) {
      return (await list(userId)).filter((rule) => rule.mode !== 'off');
    },
  };
}

export type CategoryRules = ReturnType<typeof createCategoryRules>;
