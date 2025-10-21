import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import NetWorthAnalysisTool from '../tools/NetWorthAnalysisTool';

vi.mock('ynab');

describe('NetWorthAnalysisTool', () => {
  let tool: NetWorthAnalysisTool;
  let mockApi: {
    accounts: {
      getAccounts: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      accounts: {
        getAccounts: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';

    tool = new NetWorthAnalysisTool();
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.name).toBe('ynab_net_worth_analysis');
      expect(toolDef.description).toContain('net worth');
    });

    it('should have correct input schema', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.inputSchema.properties).toHaveProperty('budgetId');
      expect(toolDef.inputSchema.properties).toHaveProperty('response_format');
    });

    it('should be marked as read-only', () => {
      const toolDef = tool.getToolDefinition();
      expect(toolDef.annotations?.readOnlyHint).toBe(true);
      expect(toolDef.annotations?.destructiveHint).toBe(false);
    });
  });

  describe('execute', () => {
    const mockAccounts = [
      {
        id: 'acc-checking',
        name: 'Checking Account',
        type: 'checking',
        balance: 500000, // $500
        on_budget: true,
        deleted: false,
        closed: false,
      },
      {
        id: 'acc-savings',
        name: 'Savings Account',
        type: 'savings',
        balance: 1000000, // $1000
        on_budget: true,
        deleted: false,
        closed: false,
      },
      {
        id: 'acc-investment',
        name: 'Investment Account',
        type: 'otherAsset',
        balance: 5000000, // $5000
        on_budget: false,
        deleted: false,
        closed: false,
      },
      {
        id: 'acc-credit-card',
        name: 'Credit Card',
        type: 'creditCard',
        balance: -200000, // -$200 (liability)
        on_budget: true,
        deleted: false,
        closed: false,
      },
      {
        id: 'acc-mortgage',
        name: 'Home Mortgage',
        type: 'mortgage',
        balance: -200000, // -$200 (liability)
        on_budget: false,
        deleted: false,
        closed: false,
      },
      {
        id: 'acc-deleted',
        name: 'Deleted Account',
        type: 'checking',
        balance: 100000,
        on_budget: true,
        deleted: true,
        closed: false,
      },
    ];

    it('should calculate net worth correctly', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult).toHaveProperty('current_net_worth');
      expect(parsedResult).toHaveProperty('total_assets');
      expect(parsedResult).toHaveProperty('total_liabilities');

      // Assets: 500 + 1000 + 5000 = 6500
      // Liabilities: -200 + -200 = -400
      // Net Worth: 6500 - 400 = 6100
      expect(parsedResult.current_net_worth).toBe(6100);
      expect(parsedResult.total_assets).toBe(6500);
      expect(parsedResult.total_liabilities).toBe(-400);
    });

    it('should categorize accounts as assets or liabilities', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_breakdown).toHaveProperty('assets');
      expect(parsedResult.account_breakdown).toHaveProperty('liabilities');

      expect(parsedResult.account_breakdown.assets).toHaveLength(3);
      expect(parsedResult.account_breakdown.liabilities).toHaveLength(2);
    });

    it('should exclude deleted accounts', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const allAccounts = [
        ...parsedResult.account_breakdown.assets,
        ...parsedResult.account_breakdown.liabilities,
      ];

      expect(allAccounts.every((acc: any) => acc.name !== 'Deleted Account')).toBe(true);
    });

    it('should generate insights about largest assets', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.insights).toBeInstanceOf(Array);
      expect(parsedResult.insights.length).toBeGreaterThan(0);

      const assetInsight = parsedResult.insights.find((i: string) => i.includes('largest assets'));
      expect(assetInsight).toBeDefined();
    });

    it('should generate insights about largest liabilities', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);

      const liabilityInsight = parsedResult.insights.find((i: string) =>
        i.includes('largest liabilities')
      );
      expect(liabilityInsight).toBeDefined();
    });

    it('should detect liquid assets', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);

      const liquidAssetsInsight = parsedResult.insights.find((i: string) =>
        i.includes('liquid assets')
      );
      expect(liquidAssetsInsight).toBeDefined();
      expect(liquidAssetsInsight).toContain('$1500'); // $500 + $1000 (without comma formatting)
    });

    it('should handle real estate accounts', async () => {
      const accountsWithRealEstate = [
        ...mockAccounts,
        {
          id: 'acc-house',
          name: 'My House',
          type: 'otherAsset',
          balance: 30000000, // $30,000
          on_budget: false,
          deleted: false,
          closed: false,
        },
      ];

      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: accountsWithRealEstate },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);

      const realEstateInsight = parsedResult.insights.find((i: string) =>
        i.includes('Real estate')
      );
      expect(realEstateInsight).toBeDefined();
    });

    it('should handle accounts with all account types', async () => {
      const allAccountTypes = [
        { id: '1', name: 'Checking', type: 'checking', balance: 100000, on_budget: true, deleted: false, closed: false },
        { id: '2', name: 'Savings', type: 'savings', balance: 100000, on_budget: true, deleted: false, closed: false },
        { id: '3', name: 'Cash', type: 'cash', balance: 100000, on_budget: true, deleted: false, closed: false },
        { id: '4', name: 'Credit Card', type: 'creditCard', balance: -50000, on_budget: true, deleted: false, closed: false },
        { id: '5', name: 'Mortgage', type: 'mortgage', balance: -1000000, on_budget: false, deleted: false, closed: false },
        { id: '6', name: 'Auto Loan', type: 'autoLoan', balance: -200000, on_budget: false, deleted: false, closed: false },
        { id: '7', name: 'Student Loan', type: 'studentLoan', balance: -300000, on_budget: false, deleted: false, closed: false },
        { id: '8', name: 'Other Asset', type: 'otherAsset', balance: 500000, on_budget: false, deleted: false, closed: false },
        { id: '9', name: 'Other Liability', type: 'otherLiability', balance: -100000, on_budget: false, deleted: false, closed: false },
      ];

      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: allAccountTypes },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.account_breakdown.assets.length).toBeGreaterThan(0);
      expect(parsedResult.account_breakdown.liabilities.length).toBeGreaterThan(0);
    });

    it('should return markdown format when requested', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'markdown',
      });

      expect(result.content[0].text).toContain('# Net Worth Analysis');
      expect(result.content[0].text).toContain('## Summary');
      expect(result.content[0].text).toContain('## Assets');
      expect(result.content[0].text).toContain('## Liabilities');
      expect(result.content[0].text).toContain('## Insights');
    });

    it('should handle empty account list', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [] },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.current_net_worth).toBe(0);
      expect(parsedResult.total_assets).toBe(0);
      expect(parsedResult.total_liabilities).toBe(0);
    });

    it('should handle missing budget ID', async () => {
      delete process.env.YNAB_BUDGET_ID;
      tool = new NetWorthAnalysisTool();

      const result = await tool.execute({
        response_format: 'json',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Budget ID is required');
    });

    it('should handle API errors', async () => {
      const apiError = new Error('API Error: Unauthorized');
      mockApi.accounts.getAccounts.mockRejectedValue(apiError);

      const result = await tool.execute({
        budgetId: 'test-budget-id',
      });

      expect(result).toHaveProperty('isError', true);
      expect(result.content[0].text).toContain('Error analyzing net worth');
    });

    it('should include note about historical limitations', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      expect(parsedResult.note).toContain('current account balances only');
      expect(parsedResult.note).toContain('Historical net worth trends are not available');
    });

    it('should handle on-budget and off-budget accounts', async () => {
      mockApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: mockAccounts },
      });

      const result = await tool.execute({
        budgetId: 'test-budget-id',
        response_format: 'json',
      });

      const parsedResult = JSON.parse(result.content[0].text);
      const allAccounts = [
        ...parsedResult.account_breakdown.assets,
        ...parsedResult.account_breakdown.liabilities,
      ];

      const onBudgetAccounts = allAccounts.filter((acc: any) => acc.on_budget);
      const offBudgetAccounts = allAccounts.filter((acc: any) => !acc.on_budget);

      expect(onBudgetAccounts.length).toBeGreaterThan(0);
      expect(offBudgetAccounts.length).toBeGreaterThan(0);
    });
  });
});
