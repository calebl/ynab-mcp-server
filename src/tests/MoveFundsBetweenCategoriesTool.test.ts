import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import MoveFundsBetweenCategoriesTool from '../tools/MoveFundsBetweenCategoriesTool';

vi.mock('ynab');

describe('MoveFundsBetweenCategoriesTool', () => {
  let tool: MoveFundsBetweenCategoriesTool;
  let mockApi: {
    months: {
      getBudgetMonth: Mock;
    };
    categories: {
      updateMonthCategory: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      months: {
        getBudgetMonth: vi.fn(),
      },
      categories: {
        updateMonthCategory: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new MoveFundsBetweenCategoriesTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_move_funds_between_categories');
      expect(toolDef.description).toContain('Transfer budgeted amounts');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('month');
      expect(toolDef.inputSchema.properties).toHaveProperty('moves');
      expect(toolDef.inputSchema.properties).toHaveProperty('dryRun');
      expect(toolDef.inputSchema.required).toContain('moves');
    });

    it('should have moves array with required fields', () => {
      const toolDef = tool.getToolDefinition();
      const movesSchema = toolDef.inputSchema.properties.moves;
      expect(movesSchema.items.required).toEqual(['fromCategoryId', 'toCategoryId', 'amount']);
    });
  });

  describe('execute', () => {
    const mockMonthData = {
      month: '2024-01-01',
      categories: [
        {
          id: 'cat-from',
          name: 'Entertainment',
          balance: 150000,
          budgeted: 200000,
          activity: -50000,
          deleted: false,
          hidden: false,
          category_group_name: 'Fun',
        },
        {
          id: 'cat-to',
          name: 'Groceries',
          balance: 10000,
          budgeted: 100000,
          activity: -90000,
          deleted: false,
          hidden: false,
          category_group_name: 'Food',
        },
      ],
    };

    it('should execute a single move successfully', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
        dryRun: false,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).toHaveBeenCalledTimes(2);

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.successfulMoves).toBe(1);
      expect(parsedResult.failedMoves).toBe(0);
      expect(parsedResult.moves[0].status).toBe('success');
    });

    it('should handle dry run mode', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
        dryRun: true,
        response_format: 'json',
      });

      expect(mockApi.categories.updateMonthCategory).not.toHaveBeenCalled();

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.dryRun).toBe(true);
      expect(parsedResult.moves[0].status).toBe('simulated');
    });

    it('should handle multiple moves', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 30,
          },
          {
            fromCategoryId: 'cat-to',
            toCategoryId: 'cat-from',
            amount: 10,
          },
        ],
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.totalMoves).toBe(2);
      expect(parsedResult.successfulMoves).toBe(2);
    });

    it('should validate insufficient funds', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 500, // More than available
          },
        ],
        dryRun: false,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Insufficient funds');
    });

    it('should reject move from category to itself', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-from',
            amount: 50,
          },
        ],
        dryRun: false,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Cannot move funds from category to itself');
    });

    it('should reject zero amount move', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 0,
          },
        ],
        dryRun: false,
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Amount must be non-zero');
    });

    it('should handle negative amounts for accumulated savings', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: -50, // Negative amount to dip into savings
          },
        ],
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.moves[0].status).toBe('success');
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new MoveFundsBetweenCategoriesTool();

      const result = await tool.execute({
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle no moves provided', async () => {
      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [],
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('No moves specified');
    });

    it('should handle invalid source category', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'invalid-cat',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Source category');
      expect(result.content[0].text).toContain('not found');
    });

    it('should handle invalid target category', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'invalid-cat',
            amount: 50,
          },
        ],
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Target category');
      expect(result.content[0].text).toContain('not found');
    });

    it('should return markdown format when requested', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory.mockResolvedValue({
        data: { category: {} },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
        dryRun: false,
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Move Funds Between Categories');
      expect(result.content[0].text).toContain('## Summary');
      expect(result.content[0].text).toContain('## Moves');
    });

    it('should handle API errors', async () => {
      const apiError = new Error('API Error: Connection timeout');
      mockApi.months.getBudgetMonth.mockRejectedValue(apiError);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error moving funds');
    });

    it('should handle partial update failures', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });
      mockApi.categories.updateMonthCategory
        .mockResolvedValueOnce({ data: { category: {} } }) // First update (from category) succeeds
        .mockRejectedValue(new Error('Update failed')); // All subsequent updates (to category) fail

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
        dryRun: false,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.moves[0].status).toBe('failed');
      expect(parsedResult.moves[0].error).toContain('Update failed');
    });

    it('should show correct before/after balances in dry run', async () => {
      mockApi.months.getBudgetMonth.mockResolvedValue({
        data: { month: mockMonthData },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        month: 'current',
        moves: [
          {
            fromCategoryId: 'cat-from',
            toCategoryId: 'cat-to',
            amount: 50,
          },
        ],
        dryRun: true,
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const move = parsedResult.moves[0];

      expect(move.fromBalanceBefore).toBe(200); // $200 budgeted
      expect(move.fromBalanceAfter).toBe(150); // $150 after move
      expect(move.toBalanceBefore).toBe(100); // $100 budgeted
      expect(move.toBalanceAfter).toBe(150); // $150 after move
    });
  });
});
