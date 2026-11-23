import { MAIL_CATEGORIES, MAIL_CATEGORY_DESCRIPTIONS, type MailCategory } from '@onebox/contracts';
import { ValidationError } from '@onebox/errors';
import type { AiCollections } from '../db/collections';

const MIN_DESCRIPTION = 10;

export interface CategoryRuleInput {
  // null puts the default description back.
  description?: string | null | undefined;
  enabled?: boolean | undefined;
}

// The built-in categories every user starts with: on, with OneBox's descriptions, which they can
// reword or switch off.
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
        description: rule?.description ?? defaultDescription,
        defaultDescription,
        customized: Boolean(rule?.description),
        enabled: rule?.enabled ?? true,
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
          enabled: input.enabled ?? current.enabled,
          updatedAt: new Date(),
        },
        { upsert: true },
      );
      return (await list(userId)).find((rule) => rule.category === category)!;
    },

    // What the classifier sorts into.
    async enabled(userId: string) {
      return (await list(userId))
        .filter((rule) => rule.enabled)
        .map(({ category, description }) => ({ category, description }));
    },
  };
}

export type CategoryRules = ReturnType<typeof createCategoryRules>;
