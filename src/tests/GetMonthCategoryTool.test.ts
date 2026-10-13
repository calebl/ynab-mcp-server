import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetMonthCategoryTool from '../tools/GetMonthCategoryTool';

vi.mock('ynab');

const mockCategory = {
  id: 'cat-1',
  name: 'Groceries',
  category_group_id: 'group-1',
  category_group_name: 'Everyday',
  hidden: false,
  deleted: false,
  budgeted: 600000,
  activity: -450500,
  balance: 149500,
  goal_type: 'NEED',
  goal_target: 600000,
  goal_percentage_complete: 75,
  goal_under_funded: 150000,
};

describe('GetMonthCategoryTool', () => {
  let mockApi: { categories: { getMonthCategoryById: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { categories: { getMonthCategoryById: vi.fn() } };
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('calls getMonthCategoryById with an explicit month and returns dollars', async () => {
    mockApi.categories.getMonthCategoryById.mockResolvedValue({ data: { category: mockCategory } });

    const result = await GetMonthCategoryTool.execute({ month: '2024-02-01', categoryId: 'cat-1' }, mockApi as any);

    expect(mockApi.categories.getMonthCategoryById).toHaveBeenCalledWith('test-budget-id', '2024-02-01', 'cat-1');
    const { category } = JSON.parse(result.content[0].text);
    expect(category.activity).toBe(-450.5);
    expect(category.balance).toBe(149.5);
    expect(category.goal_under_funded).toBe(150);
  });

  it("defaults month to 'current' when omitted", async () => {
    mockApi.categories.getMonthCategoryById.mockResolvedValue({ data: { category: mockCategory } });

    await GetMonthCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);

    expect(mockApi.categories.getMonthCategoryById).toHaveBeenCalledWith('test-budget-id', 'current', 'cat-1');
  });

  it('rejects an invalid month in the schema', () => {
    expect(GetMonthCategoryTool.inputSchema.month.safeParse('2024-13').success).toBe(false);
    expect(GetMonthCategoryTool.inputSchema.month.safeParse('current').success).toBe(true);
  });

  it('returns an error result when the API fails', async () => {
    mockApi.categories.getMonthCategoryById.mockRejectedValue(new Error('API Error'));

    const result = await GetMonthCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });

  it('returns an error when no plan ID is available', async () => {
    delete process.env.YNAB_PLAN_ID;
    delete process.env.YNAB_BUDGET_ID;

    const result = await GetMonthCategoryTool.execute({ categoryId: 'cat-1' }, mockApi as any);

    expect(JSON.parse(result.content[0].text).error).toContain('No plan ID provided');
  });

  it('has the ynab_get_month_category name', () => {
    expect(GetMonthCategoryTool.name).toBe('ynab_get_month_category');
  });
});
