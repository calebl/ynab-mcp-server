import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListMonthsTool from '../tools/ListMonthsTool';

vi.mock('ynab');

describe('ListMonthsTool', () => {
  let mockApi: {
    months: {
      getBudgetMonths: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      months: {
        getBudgetMonths: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockMonthsData = {
      data: {
        months: [
          {
            month: '2024-01-01',
            note: 'January budget',
            income: 5000000,
            budgeted: 4500000,
            activity: -4200000,
            to_be_budgeted: 500000,
            age_of_money: 45,
          },
          {
            month: '2024-02-01',
            note: null,
            income: 5200000,
            budgeted: 4800000,
            activity: -4600000,
            to_be_budgeted: 400000,
            age_of_money: 48,
          },
          {
            month: '2024-03-01',
            note: 'Tax season',
            income: 5500000,
            budgeted: 5000000,
            activity: -3000000,
            to_be_budgeted: 500000,
            age_of_money: 50,
          },
        ],
      },
    };

    it('should successfully list all months', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue(mockMonthsData);

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.months.getBudgetMonths).toHaveBeenCalledWith('test-budget-id');

      const response = JSON.parse(result.content[0].text);
      expect(response.month_count).toBe(3);
      expect(response.months).toHaveLength(3);
    });

    it('should format amounts correctly', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue(mockMonthsData);

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const januaryMonth = response.months.find((m: any) => m.month === '2024-01-01');

      expect(januaryMonth.income).toBe('5000.00');
      expect(januaryMonth.budgeted).toBe('4500.00');
      expect(januaryMonth.activity).toBe('-4200.00');
      expect(januaryMonth.to_be_budgeted).toBe('500.00');
    });

    it('should include month metadata', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue(mockMonthsData);

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const januaryMonth = response.months.find((m: any) => m.month === '2024-01-01');

      expect(januaryMonth.note).toBe('January budget');
      expect(januaryMonth.age_of_money).toBe(45);
    });

    it('should handle null notes', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue(mockMonthsData);

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const februaryMonth = response.months.find((m: any) => m.month === '2024-02-01');

      expect(februaryMonth.note).toBeNull();
    });

    it('should use YNAB_BUDGET_ID from env when budgetId not provided', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue(mockMonthsData);

      await ListMonthsTool.execute({}, mockApi as any);

      expect(mockApi.months.getBudgetMonths).toHaveBeenCalledWith('test-budget-id');
    });

    it('should return error when no budget ID available', async () => {
      delete process.env.YNAB_BUDGET_ID;

      const result = await ListMonthsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No budget ID provided');
    });

    it('should handle API error', async () => {
      mockApi.months.getBudgetMonths.mockRejectedValue(new Error('API Error'));

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });

    it('should handle empty months list', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue({
        data: { months: [] },
      });

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.month_count).toBe(0);
      expect(response.months).toHaveLength(0);
    });

    it('should handle months with zero values', async () => {
      mockApi.months.getBudgetMonths.mockResolvedValue({
        data: {
          months: [
            {
              month: '2024-01-01',
              note: null,
              income: 0,
              budgeted: 0,
              activity: 0,
              to_be_budgeted: 0,
              age_of_money: null,
            },
          ],
        },
      });

      const result = await ListMonthsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const month = response.months[0];

      expect(month.income).toBe('0.00');
      expect(month.budgeted).toBe('0.00');
      expect(month.activity).toBe('0.00');
      expect(month.to_be_budgeted).toBe('0.00');
      expect(month.age_of_money).toBeNull();
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListMonthsTool.name).toBe('ynab_list_months');
      expect(ListMonthsTool.description).toContain('budget months');
    });

    it('should have optional budgetId in input schema', () => {
      expect(ListMonthsTool.inputSchema).toHaveProperty('budgetId');
    });
  });
});
