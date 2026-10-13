import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetMonthTool from '../tools/GetMonthTool';

vi.mock('ynab');

const category = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  category_group_id: 'group-1',
  hidden: false,
  deleted: false,
  budgeted: 100000,
  activity: -50000,
  balance: 50000,
  ...overrides,
});

const mockMonth = {
  data: {
    month: {
      month: '2024-01-01',
      note: 'January',
      income: 5000000,
      budgeted: 4500000,
      activity: -4200500,
      to_be_budgeted: 500000,
      age_of_money: 45,
      categories: [
        category('cat-visible'),
        category('cat-hidden', { hidden: true }),
        category('cat-deleted', { deleted: true }),
      ],
    },
  },
};

describe('GetMonthTool', () => {
  let mockApi: { months: { getPlanMonth: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { months: { getPlanMonth: vi.fn() } };
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('returns month totals in dollars', async () => {
    mockApi.months.getPlanMonth.mockResolvedValue(mockMonth);

    const result = await GetMonthTool.execute({ month: '2024-01-01' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', '2024-01-01');
    expect(response.month).toBe('2024-01-01');
    expect(response.income).toBe(5000);
    expect(response.budgeted).toBe(4500);
    expect(response.activity).toBe(-4200.5);
    expect(response.to_be_budgeted).toBe(500);
    expect(response.age_of_money).toBe(45);
  });

  it('omits deleted categories and keeps hidden ones flagged', async () => {
    mockApi.months.getPlanMonth.mockResolvedValue(mockMonth);

    const result = await GetMonthTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);
    const ids = response.categories.map((c: any) => c.id);

    expect(ids).not.toContain('cat-deleted');
    expect(response.categories.find((c: any) => c.id === 'cat-hidden').hidden).toBe(true);
    expect(response.categories[0].budgeted).toBe(100);
    expect(response.category_count).toBe(response.categories.length);
    expect(response.category_count).toBe(2);
  });

  it("defaults month to 'current' when omitted", async () => {
    mockApi.months.getPlanMonth.mockResolvedValue(mockMonth);

    await GetMonthTool.execute({}, mockApi as any);

    expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', 'current');
  });

  it('returns an error result when the API fails', async () => {
    mockApi.months.getPlanMonth.mockRejectedValue(new Error('API Error'));

    const result = await GetMonthTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });

  it('returns an error when no plan ID is available', async () => {
    delete process.env.YNAB_PLAN_ID;
    delete process.env.YNAB_BUDGET_ID;

    const result = await GetMonthTool.execute({}, mockApi as any);

    expect(JSON.parse(result.content[0].text).error).toContain('No plan ID provided');
  });

  it('has the ynab_get_month name', () => {
    expect(GetMonthTool.name).toBe('ynab_get_month');
  });
});
