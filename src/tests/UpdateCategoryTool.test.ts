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
    group('g-wants', 'Wants', [['c-ent', '🍿 Entertainment'], ['c-old', 'Old stuff', { hidden: true }]], { internal: true }),
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

  it('treats a move into the current group as a no-op instead of sending an empty update', async () => {
    const response = await run({ categoryId: 'c-ef', categoryGroupName: 'Savings' });
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
    expect(response).toMatchObject({ success: true, message: 'Emergency fund already matches; nothing was changed' });
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

  it('refuses a move into a group that already holds a category with the same name (REQ-014)', async () => {
    mockApi.categories.getCategories.mockResolvedValue({
      data: { category_groups: [...groups, group('g-other', 'Other', [['c-dup', 'entertainment']])] },
    });
    const response = await run({ categoryId: 'c-ent', categoryGroupName: 'Other' });
    expect(response.success).toBe(false);
    expect(response.error).toContain('already has a category named');
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('never creates a group when the move target is missing', async () => {
    const response = await run({ categoryId: 'c-ef', categoryGroupName: 'Nowhere' });
    expect(response).toMatchObject({ success: false, error: 'No category group named "Nowhere" (names must match exactly).' });
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('writes nothing for a near-miss category name and returns the closest names', async () => {
    const response = await run({ categoryName: 'Entertain', note: 'x' });
    expect(response.success).toBe(false);
    expect(response.error).toContain('Closest: 🍿 Entertainment');
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('does not rename a different category for a loose name', async () => {
    mockApi.categories.getCategories.mockResolvedValue({ data: { category_groups: [group('g-bills', 'Bills', [['c-car-ins', 'Car Insurance']])] } });
    const response = await run({ categoryName: 'Car', name: 'Vehicle' });
    expect(response.success).toBe(false);
    expect(response.error).toContain('Closest: Car Insurance');
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('writes nothing for a near-miss move target and returns the closest group names', async () => {
    const response = await run({ categoryId: 'c-ef', categoryGroupName: 'Want' });
    expect(response.error).toContain('Closest: Wants');
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('lets a note-only edit through when the group holds two names with the same exact key', async () => {
    mockApi.categories.getCategories.mockResolvedValue({ data: { category_groups: [group('g-bills', 'Bills', [['c-rent', 'Rent'], ['c-rent2', '🏠 Rent']])] } });
    const response = await run({ categoryId: 'c-rent2', note: 'due on the 1st' });
    expect(response.success).toBe(true);
    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('plan-1', 'c-rent2', { category: { note: 'due on the 1st' } });
    const target = await run({ categoryId: 'c-rent', goalTarget: 1500 });
    expect(target.success).toBe(true);
  });

  describe('restricted categories and groups', () => {
    beforeEach(() => {
      mockApi.categories.getCategories.mockResolvedValue({
        data: {
          category_groups: [
            group('g-internal', 'Internal Master Category', [['c-rta', 'Inflow: Ready to Assign', { internal: true }]], { internal: true }),
            group('g-cards', 'Credit Card Payments', [['c-visa', 'Visa']]),
            group('g-savings', 'Savings', [['c-ef', 'Emergency fund']]),
          ],
        },
      });
    });

    it.each([
      ['an internal category', { categoryId: 'c-rta', note: 'x' }, 'is internal to YNAB'],
      ['a Credit Card Payments category', { categoryName: 'Visa', note: 'x' }, 'managed by YNAB for credit card accounts'],
      ['a move into the internal group', { categoryId: 'c-ef', categoryGroupId: 'g-internal' }, 'is internal to YNAB'],
      ['a move into Credit Card Payments', { categoryId: 'c-ef', categoryGroupName: 'Credit Card Payments' }, 'managed by YNAB for credit card accounts'],
    ])('refuses %s without writing', async (_label, input, error) => {
      const response = await run(input);
      expect(response.success).toBe(false);
      expect(response.error).toContain(error);
      expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
    });
  });
});
