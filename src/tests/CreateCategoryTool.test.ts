import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import type * as ynab from 'ynab';
import * as CreateCategoryTool from '../tools/CreateCategoryTool';

function group(id: string, name: string, categories: string[] = [], extra: Record<string, unknown> = {}) {
  return {
    id, name, hidden: false, deleted: false, internal: false,
    categories: categories.map((c, i) => ({ id: `${id}-c${i}`, name: c, hidden: false, deleted: false, internal: false, category_group_id: id })),
    ...extra,
  };
}

describe('CreateCategoryTool', () => {
  let mockApi: {
    categories: { getCategories: Mock; createCategory: Mock; createCategoryGroup: Mock };
    plans: { getPlanSettingsById: Mock };
  };

  const groups = [
    group('g-internal', 'Internal Master Category', [], { internal: true }),
    group('g-cards', 'Credit Card Payments', ['Visa']),
    group('g-wants', 'Wants', ['🍽️ Dining out'], { internal: true }),
    group('g-archive', 'Archive', [], { hidden: true }),
  ];

  beforeEach(() => {
    mockApi = {
      categories: {
        getCategories: vi.fn().mockResolvedValue({ data: { category_groups: groups } }),
        createCategory: vi.fn().mockImplementation(async (_plan, { category }) => ({
          data: { category: { id: 'new-cat', goal_type: category.goal_target !== undefined ? 'NEED' : null, ...category } },
        })),
        createCategoryGroup: vi.fn().mockImplementation(async (_plan, { category_group }) => ({
          data: { category_group: { id: 'new-group', name: category_group.name } },
        })),
      },
      plans: { getPlanSettingsById: vi.fn().mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 2 } } } }) },
    };
  });

  const run = (input: Record<string, unknown>) =>
    CreateCategoryTool.execute({ planId: 'plan-1', name: 'Shopping', ...input } as any, mockApi as unknown as ynab.API)
      .then((result) => JSON.parse(result.content[0].text));

  it('creates a category in a group given by id', async () => {
    const response = await run({ categoryGroupId: 'g-wants' });
    expect(mockApi.categories.createCategory).toHaveBeenCalledWith('plan-1', { category: { name: 'Shopping', category_group_id: 'g-wants' } });
    expect(response).toMatchObject({ success: true, category: { name: 'Shopping', category_group_name: 'Wants' }, createdGroup: null });
  });

  it('creates a category in a group given loosely by name', async () => {
    const response = await run({ categoryGroupName: 'want' });
    expect(response.category.category_group_id).toBe('g-wants');
  });

  it('creates the group when createGroupIfMissing is set and no group has that name', async () => {
    const response = await run({ categoryGroupName: 'Debt', createGroupIfMissing: true });
    expect(mockApi.categories.createCategoryGroup).toHaveBeenCalledWith('plan-1', { category_group: { name: 'Debt' } });
    expect(response).toMatchObject({ success: true, createdGroup: { id: 'new-group', name: 'Debt' } });
  });

  it('does not let a near match stand in for a group it was told to create', async () => {
    await run({ categoryGroupName: 'Wants extra', createGroupIfMissing: true });
    expect(mockApi.categories.createCategoryGroup).toHaveBeenCalled();
  });

  it.each([
    ['an invalid id', { categoryGroupId: 'missing' }, 'No category group with id'],
    ['a hidden group name', { categoryGroupName: 'Archive' }, 'is hidden'],
    ['a reserved group name', { categoryGroupName: 'Credit Card Payments' }, 'credit card accounts'],
    ['an internal group id', { categoryGroupId: 'g-internal' }, 'internal to YNAB'],
  ])('never creates a group for %s', async (_label, input, error) => {
    const response = await run({ ...input, createGroupIfMissing: true });
    expect(response.success).toBe(false);
    expect(response.error).toContain(error);
    expect(mockApi.categories.createCategoryGroup).not.toHaveBeenCalled();
    expect(mockApi.categories.createCategory).not.toHaveBeenCalled();
  });

  it('never creates a group for an ambiguous name', async () => {
    mockApi.categories.getCategories.mockResolvedValue({ data: { category_groups: [...groups, group('g-wants2', 'wants')] } });
    const response = await run({ categoryGroupName: 'Wants', createGroupIfMissing: true });
    expect(response.error).toContain('matches several');
    expect(mockApi.categories.createCategoryGroup).not.toHaveBeenCalled();
  });

  it('reports a missing group without createGroupIfMissing', async () => {
    const response = await run({ categoryGroupName: 'Zzz' });
    expect(response).toMatchObject({ success: false, error: 'No category group matching "Zzz"' });
  });

  it('refuses a name already used in the group', async () => {
    const response = await run({ categoryGroupId: 'g-wants', name: 'dining out' });
    expect(response.error).toContain('already has a category named "🍽️ Dining out"');
    expect(mockApi.categories.createCategory).not.toHaveBeenCalled();
  });

  it.each([
    ['a blank name', { name: '  ' }],
    ['an over-long group name', { categoryGroupId: undefined, categoryGroupName: 'x'.repeat(51), createGroupIfMissing: true }],
    ['an invalid date', { categoryGroupId: 'g-wants', goalTargetDate: '2027-02-30' }],
    ['a negative target', { categoryGroupId: 'g-wants', goalTarget: -5 }],
    ['a NaN target', { categoryGroupId: 'g-wants', goalTarget: Number.NaN }],
  ])('rejects %s before reading or writing anything', async (_label, input) => {
    const response = await run({ categoryGroupId: 'g-wants', ...input });
    expect(response.success).toBe(false);
    expect(mockApi.categories.getCategories).not.toHaveBeenCalled();
  });

  it('passes a zero target, an empty note and a target date through', async () => {
    const response = await run({ categoryGroupId: 'g-wants', goalTarget: 0, note: '', goalTargetDate: '2027-03-01' });
    expect(mockApi.categories.createCategory).toHaveBeenCalledWith('plan-1', {
      category: { name: 'Shopping', category_group_id: 'g-wants', note: '', goal_target: 0, goal_target_date: '2027-03-01' },
    });
    expect(response.category).toMatchObject({ goal_target: 0, goal_target_date: '2027-03-01' });
  });

  it('converts the target to milliunits', async () => {
    await run({ categoryGroupId: 'g-wants', goalTarget: 210.5 });
    expect(mockApi.categories.createCategory.mock.calls[0][1].category.goal_target).toBe(210500);
  });

  it('reports the group it created when the category then fails', async () => {
    mockApi.categories.createCategory.mockRejectedValue({ error: { id: '400', name: 'bad_request', detail: 'name too long' } });
    const response = await run({ categoryGroupName: 'Debt', createGroupIfMissing: true });
    expect(response).toMatchObject({ success: false, createdGroup: { id: 'new-group', name: 'Debt' } });
  });

  it('surfaces API errors', async () => {
    mockApi.categories.getCategories.mockRejectedValue(new Error('boom'));
    const response = await run({ categoryGroupId: 'g-wants' });
    expect(response).toEqual({ success: false, error: 'boom' });
  });
});
