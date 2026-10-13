import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as UpdateCategoryTool from '../tools/UpdateCategoryTool';

vi.mock('ynab');

const updatedCategory = {
  id: 'cat-1',
  name: 'Vacation',
  category_group_id: 'group-1',
  hidden: false,
  deleted: false,
  budgeted: 100000,
  activity: 0,
  balance: 100000,
  goal_type: 'MF',
  goal_target: 250500,
  goal_under_funded: 150500,
};

describe('UpdateCategoryTool', () => {
  let mockApi: { categories: { updateCategory: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { categories: { updateCategory: vi.fn() } };
    mockApi.categories.updateCategory.mockResolvedValue({ data: { category: updatedCategory, server_knowledge: 1 } });
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('converts goalTarget from dollars to milliunits and sends only that field', async () => {
    await UpdateCategoryTool.execute({ categoryId: 'cat-1', goalTarget: 250.5 }, mockApi as any);

    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('test-budget-id', 'cat-1', {
      category: { goal_target: 250500 },
    });
  });

  it('sends only name and note when only those are given', async () => {
    await UpdateCategoryTool.execute({ categoryId: 'cat-1', name: 'Vacation', note: '' }, mockApi as any);

    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('test-budget-id', 'cat-1', {
      category: { name: 'Vacation', note: '' },
    });
  });

  it('maps goalTargetDate, goalNeedsWholeAmount and categoryGroupId', async () => {
    await UpdateCategoryTool.execute({
      categoryId: 'cat-1',
      goalTargetDate: '2026-12-01',
      goalNeedsWholeAmount: false,
      categoryGroupId: 'group-2',
    }, mockApi as any);

    expect(mockApi.categories.updateCategory).toHaveBeenCalledWith('test-budget-id', 'cat-1', {
      category: { goal_target_date: '2026-12-01', goal_needs_whole_amount: false, category_group_id: 'group-2' },
    });
  });

  it('returns the updated category in dollars', async () => {
    const result = await UpdateCategoryTool.execute({ categoryId: 'cat-1', goalTarget: 250.5 }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(true);
    expect(response.category.goal_target).toBe(250.5);
    expect(response.category.goal_under_funded).toBe(150.5);
    expect(response.category.budgeted).toBe(100);
    expect(response.message).toBe('Updated category Vacation');
  });

  it('fails without calling YNAB when no updatable field is given', async () => {
    const result = await UpdateCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error.startsWith('Provide at least one field')).toBe(true);
    expect(result.isError).toBe(true);
    expect(mockApi.categories.updateCategory).not.toHaveBeenCalled();
  });

  it('rejects a negative goalTarget in the schema', () => {
    expect(UpdateCategoryTool.inputSchema.goalTarget.safeParse(-1).success).toBe(false);
  });

  it('returns an error result when the API fails', async () => {
    mockApi.categories.updateCategory.mockRejectedValue(new Error('API Error'));

    const result = await UpdateCategoryTool.execute({ categoryId: 'cat-1', name: 'X' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });

  it('returns an error when no plan ID is available', async () => {
    delete process.env.YNAB_PLAN_ID;
    delete process.env.YNAB_BUDGET_ID;

    const result = await UpdateCategoryTool.execute({ categoryId: 'cat-1', name: 'X' }, mockApi as any);

    expect(JSON.parse(result.content[0].text).error).toContain('No plan ID provided');
  });

  it('has the ynab_update_category name', () => {
    expect(UpdateCategoryTool.name).toBe('ynab_update_category');
  });
});
