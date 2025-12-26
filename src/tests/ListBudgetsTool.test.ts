import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as ListBudgetsTool from '../tools/ListBudgetsTool';

vi.mock('ynab');

describe('ListBudgetsTool', () => {
  let mockApi: {
    budgets: {
      getBudgets: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      budgets: {
        getBudgets: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
  });

  describe('execute', () => {
    const mockBudgetsData = [
      {
        id: 'budget-1',
        name: 'My Personal Budget',
        last_modified_on: '2023-01-01T00:00:00Z',
        first_month: '2023-01-01',
        last_month: '2023-12-01',
        date_format: {
          format: 'MM/DD/YYYY',
        },
        currency_format: {
          iso_code: 'USD',
          example_format: '123,456.78',
          decimal_digits: 2,
          decimal_separator: '.',
          symbol_first: true,
          group_separator: ',',
          currency_symbol: '$',
          display_symbol: true,
        },
      },
      {
        id: 'budget-2',
        name: 'Family Budget',
        last_modified_on: '2023-01-02T00:00:00Z',
        first_month: '2023-01-01',
        last_month: '2023-12-01',
        date_format: {
          format: 'DD/MM/YYYY',
        },
        currency_format: {
          iso_code: 'EUR',
          example_format: '123.456,78',
          decimal_digits: 2,
          decimal_separator: ',',
          symbol_first: false,
          group_separator: '.',
          currency_symbol: '€',
          display_symbol: true,
        },
      },
      {
        id: 'budget-3',
        name: 'Business Budget',
        last_modified_on: '2023-01-03T00:00:00Z',
        first_month: '2023-01-01',
        last_month: '2023-12-01',
        date_format: {
          format: 'YYYY-MM-DD',
        },
        currency_format: {
          iso_code: 'GBP',
          example_format: '£123,456.78',
          decimal_digits: 2,
          decimal_separator: '.',
          symbol_first: true,
          group_separator: ',',
          currency_symbol: '£',
          display_symbol: true,
        },
      },
    ];

    it('should successfully list all budgets', async () => {
      mockApi.budgets.getBudgets.mockResolvedValue({
        data: { budgets: mockBudgetsData },
      });

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      expect(mockApi.budgets.getBudgets).toHaveBeenCalledWith();

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify([
            { id: 'budget-1', name: 'My Personal Budget' },
            { id: 'budget-2', name: 'Family Budget' },
            { id: 'budget-3', name: 'Business Budget' },
          ], null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should handle empty budget list', async () => {
      mockApi.budgets.getBudgets.mockResolvedValue({
        data: { budgets: [] },
      });

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      expect(mockApi.budgets.getBudgets).toHaveBeenCalledWith();

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify([], null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should handle single budget', async () => {
      const singleBudget = [mockBudgetsData[0]];

      mockApi.budgets.getBudgets.mockResolvedValue({
        data: { budgets: singleBudget },
      });

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify([
            { id: 'budget-1', name: 'My Personal Budget' },
          ], null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });

    it('should return error message when YNAB API token is not set', async () => {
      delete process.env.YNAB_API_TOKEN;

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      const expectedResult = {
        content: [{ type: "text", text: "YNAB API Token is not set" }]
      };

      expect(result).toEqual(expectedResult);
      expect(mockApi.budgets.getBudgets).not.toHaveBeenCalled();
    });

    it('should return error message when YNAB API token is empty string', async () => {
      process.env.YNAB_API_TOKEN = '';

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      const expectedResult = {
        content: [{ type: "text", text: "YNAB API Token is not set" }]
      };

      expect(result).toEqual(expectedResult);
      expect(mockApi.budgets.getBudgets).not.toHaveBeenCalled();
    });

    it('should handle API error', async () => {
      const apiError = new Error('API Error: Unauthorized');
      mockApi.budgets.getBudgets.mockRejectedValue(apiError);

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('API Error: Unauthorized');
    });

    it('should handle budgets with special characters in names', async () => {
      const specialBudgets = [
        {
          id: 'budget-special-1',
          name: 'Budget with "Quotes" & Symbols!',
          last_modified_on: '2023-01-01T00:00:00Z',
          first_month: '2023-01-01',
          last_month: '2023-12-01',
          date_format: { format: 'MM/DD/YYYY' },
          currency_format: {
            iso_code: 'USD',
            example_format: '123,456.78',
            decimal_digits: 2,
            decimal_separator: '.',
            symbol_first: true,
            group_separator: ',',
            currency_symbol: '$',
            display_symbol: true,
          },
        },
        {
          id: 'budget-special-2',
          name: 'émojis 🎯 & ünîcødé',
          last_modified_on: '2023-01-02T00:00:00Z',
          first_month: '2023-01-01',
          last_month: '2023-12-01',
          date_format: { format: 'DD/MM/YYYY' },
          currency_format: {
            iso_code: 'EUR',
            example_format: '123.456,78',
            decimal_digits: 2,
            decimal_separator: ',',
            symbol_first: false,
            group_separator: '.',
            currency_symbol: '€',
            display_symbol: true,
          },
        },
      ];

      mockApi.budgets.getBudgets.mockResolvedValue({
        data: { budgets: specialBudgets },
      });

      const result = await ListBudgetsTool.execute({}, mockApi as any);

      const expectedResult = {
        content: [{
          type: "text",
          text: JSON.stringify([
            { id: 'budget-special-1', name: 'Budget with "Quotes" & Symbols!' },
            { id: 'budget-special-2', name: 'émojis 🎯 & ünîcødé' },
          ], null, 2)
        }]
      };

      expect(result).toEqual(expectedResult);
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(ListBudgetsTool.name).toBe('ynab_list_budgets');
      expect(ListBudgetsTool.description).toBe('Lists all available budgets from YNAB API');
    });

    it('should have empty input schema', () => {
      expect(ListBudgetsTool.inputSchema).toEqual({});
    });
  });
});