import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import type * as ynab from 'ynab';
import * as UpdateCategoryTool from '../tools/UpdateCategoryTool';

function group(id: string, name: string, categories: Array<[string, string, Record<string, unknown>?]>, extra: Record<string, unknown> = {}) {
  return {
    id, name, hidden: false, deleted: false, internal: false,
    categories: categories.map(([cid, cname, cextra]) => ({ id: cid, name: cname, hidden: false, deleted: false, internal: false, category_group_id: id, note: null, ...cextra })),
    ...extra,
  };
}

describe('UpdateCategoryTool', () => {
  let mockApi: {
    categories: { getCategories: Mock; updateCategory: Mock };
    plans: { getPlanSettingsById: Mock };
  };

  const groups = [
    group('g-wants', 'Wants', [['c-ent', '🍿 Entertainment'], ['c-old', 'Old stuff', { hidden: true }]]),
    group('g-savings', 'Savings', [['c-ef', 'Emergency fund']]),
  ];

  beforeEach(() => {
    mockApi = {
      categories: {
        getCategories: vi.fn().mockResolvedValue({ data: { category_groups: groups } }),
        updateCategory: vi.fn().mockImplementation(async (_plan, id, { category }) => {
          const current = groups.flatMap((g) => g.categories).find((c) => c.id === id)!;
          return { data: { category: { ...current, ...category } } };
        }),
      },
      plans: { getPlanSettingsById: vi.fn().mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 2 } } } }) },
    };
  });

  const run = (input: Record<string, unknown>) =>
    UpdateCategoryTool.execute({ planId: 'plan-1', ...input } as any, mockApi as unknown as ynab.API)
      .then((result) => JSON.parse(result.content[0].text));

  it('renames a category by id, sending only the new name', async () => {
    const response = await run({ categoryId: 'c-ent', name: '📺 Subscriptions' });
    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('plan-1', 'c-ent', { category: { name: '📺 Subscriptions' } });
    expect(response).toMatchObject({ success: true, before: { name: '🍿 Entertainment' }, after: { name: '📺 Subscriptions' } });
  });

  it('finds a hidden category by name', async () => {
    const response = await run({ categoryName: 'old stuff', note: 'still here' });
    expect(response.category_id).toBe('c-old');
    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('plan-1', 'c-old', { category: { note: 'still here' } });
  });

  it('moves a category to a group given by name', async () => {
    const response = await run({ categoryName: 'Entertainment', categoryGroupName: 'savings' });
    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('plan-1', 'c-ent', { category: { category_group_id: 'g-savings' } });
    expect(response.after.category_group_name).toBe('Savings');
  });

  it('clears a note with an empty string', async () => {
    await run({ categoryId: 'c-ef', note: '' });
    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('plan-1', 'c-ef', { category: { note: '' } });
  });

  it('sets a target in milliunits', async () => {
    await run({ categoryId: 'c-ef', goalTarget: 1000, goalTargetDate: '2027-01-01' });
    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('plan-1', 'c-ef', { category: { goal_target: 1000000, goal_target_date: '2027-01-01' } });
  });

  it('refuses a call with nothing to change', async () => {
    const response = await run({ categoryId: 'c-ef' });
    expect(response.error).toContain('Nothing to change');
    expect(mockApi.categories.getCategories).not.toHaveBeenCalled();
  });

  it('reports an ambiguous category name', async () => {
    mockApi.categories.getCategories.mockResolvedValue({ data: { category_groups: [...groups, group('g-x', 'Other', [['c-ef2', 'emergency fund']])] } });
    const response = await run({ categoryName: 'Emergency fund', name: 'EF' });
    expect(response.error).toContain('matches several');
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('refuses a rename that clashes with another category in the group', async () => {
    const response = await run({ categoryId: 'c-old', name: 'entertainment' });
    expect(response.error).toContain('already has a category named');
  });

  it('never creates a group when the move target is missing', async () => {
    const response = await run({ categoryId: 'c-ef', categoryGroupName: 'Nowhere' });
    expect(response).toMatchObject({ success: false, error: 'No category group matching "Nowhere"' });
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });
});
