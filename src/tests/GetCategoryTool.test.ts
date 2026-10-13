import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetCategoryTool from '../tools/GetCategoryTool';

vi.mock('ynab');

const mockCategory = {
  id: 'cat-1',
  name: 'Rent',
  category_group_id: 'group-1',
  category_group_name: 'Monthly Bills',
  hidden: true,
  deleted: false,
  note: 'Due on the 1st',
  budgeted: 1500000,
  activity: -1500000,
  balance: 0,
  goal_type: 'NEED',
  goal_target: 1500000,
  goal_target_date: '2026-12-01',
  goal_needs_whole_amount: true,
  goal_cadence: 1,
  goal_percentage_complete: 100,
  goal_under_funded: 0,
};

describe('GetCategoryTool', () => {
  let mockApi: { categories: { getCategoryById: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { categories: { getCategoryById: vi.fn() } };
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('calls getCategoryById with the plan and category IDs', async () => {
    mockApi.categories.getCategoryById.mockResolvedValue({ data: { category: mockCategory } });

    await GetCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);

    expect(mockApi.categories.getCategoryById).toHaveBeenCalledWith('test-budget-id', 'cat-1');
  });

  it('returns amounts in dollars, including goal_target and goal_under_funded', async () => {
    mockApi.categories.getCategoryById.mockResolvedValue({ data: { category: mockCategory } });

    const result = await GetCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);
    const { category } = JSON.parse(result.content[0].text);

    expect(category.budgeted).toBe(1500);
    expect(category.activity).toBe(-1500);
    expect(category.balance).toBe(0);
    expect(category.goal_target).toBe(1500);
    expect(category.goal_under_funded).toBe(0);
    expect(category.goal_target_date).toBe('2026-12-01');
    expect(category.category_group_name).toBe('Monthly Bills');
  });

  it('returns a hidden category flagged hidden: true', async () => {
    mockApi.categories.getCategoryById.mockResolvedValue({ data: { category: mockCategory } });

    const result = await GetCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);

    expect(JSON.parse(result.content[0].text).category.hidden).toBe(true);
  });

  it('returns an error result when the API fails', async () => {
    mockApi.categories.getCategoryById.mockRejectedValue(new Error('API Error'));

    const result = await GetCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });

  it('returns an error when no plan ID is available', async () => {
    delete process.env.YNAB_PLAN_ID;
    delete process.env.YNAB_BUDGET_ID;

    const result = await GetCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);

    expect(JSON.parse(result.content[0].text).error).toContain('No plan ID provided');
  });

  it('has the ynab_get_category name', () => {
    expect(GetCategoryTool.name).toBe('ynab_get_category');
  });
});
