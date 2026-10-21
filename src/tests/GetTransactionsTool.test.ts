import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { z } from 'zod';
import * as ynab from 'ynab';
import * as GetTransactionsTool from '../tools/GetTransactionsTool';

vi.mock('ynab');

describe('GetTransactionsTool', () => {
  let mockApi: {
    transactions: {
      getTransactions: Mock;
      getTransactionsByAccount: Mock;
      getTransactionsByCategory: Mock;
      getTransactionsByPayee: Mock;
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockApi = {
      transactions: {
        getTransactions: vi.fn(),
        getTransactionsByAccount: vi.fn(),
        getTransactionsByCategory: vi.fn(),
        getTransactionsByPayee: vi.fn(),
      },
    };

    (ynab.API as any).mockImplementation(() => mockApi);

    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  describe('execute', () => {
    const mockTransactionsData = [
      {
        id: 'txn-1',
        date: '2024-01-15',
        amount: -25990,
        memo: 'Shopping',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Amazon',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: false,
      },
      {
        id: 'txn-2',
        date: '2024-01-16',
        amount: -15000,
        memo: 'Groceries',
        approved: false,
        cleared: 'uncleared',
        account_name: 'Checking',
        payee_name: 'Walmart',
        category_name: 'Groceries',
        flag_color: 'blue',
        transfer_account_id: null,
        deleted: false,
      },
      {
        id: 'txn-deleted',
        date: '2024-01-14',
        amount: -5000,
        memo: 'Deleted',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Store',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: true,
      },
    ];

    const mockSplitTransaction = {
      id: 'txn-split',
      date: '2024-01-17',
      amount: -82608,
      memo: null,
      approved: true,
      cleared: 'cleared',
      account_name: 'Checking',
      payee_name: 'Costco',
      category_name: 'Split',
      flag_color: null,
      transfer_account_id: null,
      deleted: false,
      subtransactions: [
        { id: 'sub-1', amount: -35000, category_name: 'Household', memo: 'printer', deleted: false },
        { id: 'sub-2', amount: -47608, category_name: 'Groceries', memo: null, deleted: false },
        { id: 'sub-3', amount: -1000, category_name: 'Gone', memo: null, deleted: true },
      ],
    };

    it('should expose the categories of a split transaction', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: [mockSplitTransaction] },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const split = response.transactions[0];

      // The parent row is categorised "Split"; without the legs it reads as
      // uncategorized.
      expect(split.category_name).toBe('Split');
      expect(split.subtransactions).toHaveLength(2); // deleted leg dropped
      expect(split.subtransactions[0]).toMatchObject({
        amount: -35,
        category_name: 'Household',
        memo: 'printer',
      });
      expect(split.subtransactions[1].category_name).toBe('Groceries');
    });

    it('should omit subtransactions on ordinary transactions', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions[0]).not.toHaveProperty('subtransactions');
    });

    it('should successfully get all transactions', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        undefined,
        undefined
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions).toHaveLength(2); // Excludes deleted
      expect(response.transaction_count).toBe(2);
    });

    it('should filter out deleted transactions', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      const txnIds = response.transactions.map((t: any) => t.id);
      expect(txnIds).not.toContain('txn-deleted');
    });

    it('should get transactions by account', async () => {
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          accountId: 'account-1',
          type: 'unapproved',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionsByAccount).toHaveBeenCalledWith(
        'test-budget-id',
        'account-1',
        undefined,
        undefined,
        ynab.GetTransactionsByAccountTypeEnum.Unapproved
      );
    });

    it('should get transactions by category', async () => {
      mockApi.transactions.getTransactionsByCategory.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          categoryId: 'category-1',
          type: 'uncategorized',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionsByCategory).toHaveBeenCalledWith(
        'test-budget-id',
        'category-1',
        undefined,
        undefined,
        ynab.GetTransactionsByCategoryTypeEnum.Uncategorized
      );
    });

    it('should get transactions by payee', async () => {
      mockApi.transactions.getTransactionsByPayee.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          payeeId: 'payee-1',
          type: 'unapproved',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactionsByPayee).toHaveBeenCalledWith(
        'test-budget-id',
        'payee-1',
        undefined,
        undefined,
        ynab.GetTransactionsByPayeeTypeEnum.Unapproved
      );
    });

    it('should filter by sinceDate', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          sinceDate: '2024-01-01',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        '2024-01-01',
        undefined,
        undefined
      );
    });

    it('should filter by type unapproved', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted && !t.approved) },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          type: 'unapproved',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        undefined,
        ynab.GetTransactionsTypeEnum.Unapproved
      );
    });

    it('should filter by type uncategorized', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: [] },
      });

      await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          type: 'uncategorized',
        },
        mockApi as any
      );

      expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith(
        'test-budget-id',
        undefined,
        undefined,
        ynab.GetTransactionsTypeEnum.Uncategorized
      );
    });

    it('should apply limit to results', async () => {
      const manyTransactions = Array.from({ length: 150 }, (_, i) => ({
        id: `txn-${i}`,
        date: '2024-01-15',
        amount: -1000,
        memo: 'Test',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Store',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: false,
      }));

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: manyTransactions },
      });

      const result = await GetTransactionsTool.execute(
        {
          budgetId: 'test-budget-id',
          limit: 50,
        },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions).toHaveLength(50);
      expect(response.total_available).toBe(150);
    });

    it('should use default limit of 100', async () => {
      const manyTransactions = Array.from({ length: 150 }, (_, i) => ({
        id: `txn-${i}`,
        date: '2024-01-15',
        amount: -1000,
        memo: 'Test',
        approved: true,
        cleared: 'cleared',
        account_name: 'Checking',
        payee_name: 'Store',
        category_name: 'Shopping',
        flag_color: null,
        transfer_account_id: null,
        deleted: false,
      }));

      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: manyTransactions },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions).toHaveLength(100);
    });

    it('should format amounts correctly', async () => {
      mockApi.transactions.getTransactions.mockResolvedValue({
        data: { transactions: mockTransactionsData.filter((t) => !t.deleted) },
      });

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.transactions[0].amount).toBe(-25.99);
      expect(response.transactions[1].amount).toBe(-15);
    });

    it('should return error when no plan ID is available', async () => {
      delete process.env.YNAB_PLAN_ID;
      delete process.env.YNAB_BUDGET_ID;

      const result = await GetTransactionsTool.execute({}, mockApi as any);

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toContain('No plan ID provided');
    });

    it('should handle API error', async () => {
      mockApi.transactions.getTransactions.mockRejectedValue(new Error('API Error'));

      const result = await GetTransactionsTool.execute(
        { budgetId: 'test-budget-id' },
        mockApi as any
      );

      const response = JSON.parse(result.content[0].text);
      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
    });
  });

  describe('tool configuration', () => {
    it('should have correct name and description', () => {
      expect(GetTransactionsTool.name).toBe('ynab_get_transactions');
      expect(GetTransactionsTool.description).toContain('Gets transactions');
    });

    it('should have filter options in input schema', () => {
      expect(GetTransactionsTool.inputSchema).toHaveProperty('budgetId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('sinceDate');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('type');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('accountId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('categoryId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('payeeId');
      expect(GetTransactionsTool.inputSchema).toHaveProperty('limit');
    });

    it('should reject a sinceDate not in YYYY-MM-DD format', () => {
      const result = (GetTransactionsTool.inputSchema.sinceDate as z.ZodType).safeParse('01/01/2024');
      expect(result.success).toBe(false);
    });

    it('should reject a non-integer, non-positive, or too-large limit', () => {
      const limit = GetTransactionsTool.inputSchema.limit as z.ZodType;
      expect(limit.safeParse(1.5).success).toBe(false);
      expect(limit.safeParse(-5).success).toBe(false);
      expect(limit.safeParse(0).success).toBe(false);
      expect(limit.safeParse(1e9).success).toBe(false);
      expect(limit.safeParse(100).success).toBe(true);
    });
  });
});

describe('GetTransactionsTool search', () => {
  const txn = (over: Record<string, unknown>) => ({
    id: 't',
    date: '2026-03-01',
    amount: -10000,
    memo: null,
    approved: true,
    cleared: 'cleared',
    account_name: 'Checking',
    payee_name: 'Shop',
    category_name: 'Groceries',
    flag_color: null,
    transfer_account_id: null,
    deleted: false,
    ...over,
  });

  const rows = [
    txn({ id: 'give-1', date: '2026-01-15', amount: -100000, payee_name: 'Red Cross', category_name: 'Giving' }),
    txn({ id: 'pay', date: '2026-02-01', amount: 300000, payee_name: 'Employer', category_name: 'Inflow: Ready to Assign' }),
    txn({
      id: 'split',
      date: '2026-03-10',
      amount: -60000,
      payee_name: 'Costco',
      category_name: 'Split',
      memo: 'big run',
      subtransactions: [
        { id: 's1', amount: -45000, memo: null, payee_name: null, category_name: 'Groceries', deleted: false },
        { id: 's2', amount: -15000, memo: 'school supplies', payee_name: null, category_name: 'Kids', deleted: false },
      ],
    }),
    txn({ id: 'gone', date: '2026-04-01', amount: -99999000, payee_name: 'Red Cross', deleted: true }),
    txn({ id: 'give-2', date: '2026-06-01', amount: -25500, payee_name: 'red cross', memo: 'Disaster fund', category_name: 'Giving' }),
  ];

  let mockApi: {
    transactions: {
      getTransactions: Mock;
      getTransactionsByAccount: Mock;
      getTransactionsByCategory: Mock;
      getTransactionsByPayee: Mock;
    };
    plans: { getPlanSettingsById: Mock };
  };

  const run = async (input: Record<string, unknown>) => {
    const result = await GetTransactionsTool.execute({ budgetId: 'test-budget-id', ...input }, mockApi as any);
    return JSON.parse(result.content[0].text);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const listing = () => vi.fn().mockResolvedValue({ data: { transactions: rows } });
    mockApi = {
      transactions: {
        getTransactions: listing(),
        getTransactionsByAccount: listing(),
        getTransactionsByCategory: listing(),
        getTransactionsByPayee: listing(),
      },
      plans: {
        getPlanSettingsById: vi.fn().mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 2 } } } }),
      },
    };
  });

  it('should leave the response unchanged when no search option is given', async () => {
    const response = await run({});
    expect(Object.keys(response)).toEqual(['transactions', 'transaction_count', 'total_available']);
    expect(response.transactions.map((t: any) => t.id)).toEqual(['give-1', 'pay', 'split', 'give-2']);
    expect(response.total_available).toBe(4);
  });

  it('should not treat explicit defaults as a search', async () => {
    const response = await run({ direction: 'any', totalsOnly: false });
    expect(Object.keys(response)).toEqual(['transactions', 'transaction_count', 'total_available']);
    expect(response.total_available).toBe(4);
  });

  it('should send untilDate to YNAB and enforce it if later rows come back', async () => {
    const response = await run({ sinceDate: '2026-01-01', untilDate: '2026-03-31' });
    expect(mockApi.transactions.getTransactions).toHaveBeenCalledWith('test-budget-id', '2026-01-01', '2026-03-31', undefined);
    expect(response.transactions.map((t: any) => t.id)).toEqual(['give-1', 'pay', 'split']);
    expect(response.totals).toEqual({ count: 3, inflow: 300, outflow: 160, net: 140 });
  });

  it('should pass untilDate to the account, category and payee listings', async () => {
    await run({ accountId: 'acct', untilDate: '2026-12-31' });
    await run({ categoryId: 'cat', untilDate: '2026-12-31' });
    await run({ payeeId: 'payee', untilDate: '2026-12-31' });
    expect(mockApi.transactions.getTransactionsByAccount).toHaveBeenCalledWith('test-budget-id', 'acct', undefined, '2026-12-31', undefined);
    expect(mockApi.transactions.getTransactionsByCategory).toHaveBeenCalledWith('test-budget-id', 'cat', undefined, '2026-12-31', undefined);
    expect(mockApi.transactions.getTransactionsByPayee).toHaveBeenCalledWith('test-budget-id', 'payee', undefined, '2026-12-31', undefined);
  });

  it('should match payee text case-insensitively', async () => {
    const response = await run({ payeeContains: 'RED CROSS' });
    expect(response.transactions.map((t: any) => t.id)).toEqual(['give-1', 'give-2']);
    expect(response.totals).toEqual({ count: 2, inflow: 0, outflow: 125.5, net: -125.5 });
  });

  it('should return only the totals with totalsOnly', async () => {
    const response = await run({ payeeContains: 'red cross', sinceDate: '2026-01-01', untilDate: '2026-12-31', totalsOnly: true });
    expect(response).toEqual({ totals: { count: 2, inflow: 0, outflow: 125.5, net: -125.5 } });
  });

  it('should match a split leg by leg and total only the matching legs', async () => {
    const byMemo = await run({ memoContains: 'school' });
    expect(byMemo.transactions.map((t: any) => t.id)).toEqual(['split']);
    expect(byMemo.transactions[0].subtransactions).toHaveLength(2); // the whole split is shown
    expect(byMemo.totals.outflow).toBe(15);

    // Legs without a payee take the payee of the whole split.
    const byPayee = await run({ payeeContains: 'costco', minAmount: 20 });
    expect(byPayee.totals.outflow).toBe(45);

    // Legs without a memo take the memo of the whole split.
    const byParentMemo = await run({ memoContains: 'big run' });
    expect(byParentMemo.totals.outflow).toBe(45);
  });

  it('should treat hybrid subtransaction rows as single legs and keep their parent id', async () => {
    // The category and payee listings return a split's legs as rows of their own, without children.
    mockApi.transactions.getTransactionsByCategory.mockResolvedValue({
      data: {
        transactions: [
          txn({ id: 's2', type: 'subtransaction', parent_transaction_id: 'split', amount: -15000, category_name: 'Kids' }),
          txn({ id: 'whole', type: 'transaction', parent_transaction_id: null, amount: -5000, category_name: 'Kids' }),
        ],
      },
    });
    const response = await run({ categoryId: 'cat-kids', direction: 'outflow' });
    expect(response.transactions[0]).toMatchObject({ id: 's2', parent_transaction_id: 'split', amount: -15 });
    expect(response.transactions[1]).not.toHaveProperty('parent_transaction_id');
    expect(response.totals).toEqual({ count: 2, inflow: 0, outflow: 20, net: -20 });
  });

  describe('when the payee listing returns a split and its legs', () => {
    // Seen against the live API: a payee listing returns the split's parent row with its full
    // amount, plus a row for each leg that carries its own payee. Legs without one are absent.
    const payeeRows = [
      txn({ id: 'parent', type: 'transaction', parent_transaction_id: null, amount: -281170, payee_name: 'Costco', category_name: 'Split', memo: 'weekly' }),
      txn({ id: 'leg-1', type: 'subtransaction', parent_transaction_id: 'parent', amount: -47920, payee_name: 'Costco', category_name: 'Household', memo: 'printer ink' }),
      txn({ id: 'other', type: 'transaction', parent_transaction_id: null, amount: -10000, payee_name: 'Costco', category_name: 'Groceries' }),
    ];

    beforeEach(() => {
      mockApi.transactions.getTransactionsByPayee.mockResolvedValue({ data: { transactions: payeeRows } });
    });

    it('should count the split once, through its parent row', async () => {
      const response = await run({ payeeId: 'payee-costco', direction: 'outflow' });
      expect(response.transactions.map((t: any) => t.id)).toEqual(['parent', 'other']);
      expect(response.totals).toEqual({ count: 2, inflow: 0, outflow: 291.17, net: -291.17 });
    });

    it('should keep a leg row when only the leg matches', async () => {
      const response = await run({ payeeId: 'payee-costco', memoContains: 'ink' });
      expect(response.transactions.map((t: any) => t.id)).toEqual(['leg-1']);
      expect(response.totals.outflow).toBe(47.92);
    });

    it('should match the parent row as YNAB returns it, at its full amount', async () => {
      // The parent row has no children here, so its memo and amount stand for the whole split,
      // although leg-1 has a memo of its own.
      const byMemo = await run({ payeeId: 'payee-costco', memoContains: 'weekly' });
      expect(byMemo.transactions.map((t: any) => t.id)).toEqual(['parent']);
      expect(byMemo.totals.outflow).toBe(281.17);

      // Too large as a whole, so only the leg row and the ordinary row are small enough.
      const small = await run({ payeeId: 'payee-costco', maxAmount: 50 });
      expect(small.transactions.map((t: any) => t.id)).toEqual(['leg-1', 'other']);
      expect(small.totals.outflow).toBe(57.92);
    });

    it('should match a category leg row on its own memo only', async () => {
      mockApi.transactions.getTransactionsByCategory.mockResolvedValue({
        data: { transactions: [txn({ id: 'leg-2', type: 'subtransaction', parent_transaction_id: 'parent', amount: -233250, memo: null })] },
      });
      const response = await run({ categoryId: 'cat-groceries', memoContains: 'weekly' });
      expect(response.totals).toEqual({ count: 0, inflow: 0, outflow: 0, net: 0 });
    });

    it('should still list every row when no search option is given', async () => {
      const response = await run({ payeeId: 'payee-costco' });
      expect(response.transactions.map((t: any) => t.id)).toEqual(['parent', 'leg-1', 'other']);
    });
  });

  it('should keep amount bounds exact rather than rounding them to milliunits', async () => {
    mockApi.transactions.getTransactions.mockResolvedValue({
      data: { transactions: [txn({ id: 'a', amount: -1234 }), txn({ id: 'b', amount: -1235 }), txn({ id: 'c', amount: -25500 })] },
    });
    expect((await run({ maxAmount: 1.2345 })).transactions.map((t: any) => t.id)).toEqual(['a']);
    expect((await run({ minAmount: 1.2344, maxAmount: 2 })).transactions.map((t: any) => t.id)).toEqual(['b']);
    // A bound equal to an amount still includes it.
    expect((await run({ minAmount: 25.5, maxAmount: 25.5 })).transactions.map((t: any) => t.id)).toEqual(['c']);
  });

  it('should apply direction and amount bounds to the absolute amount', async () => {
    const inflow = await run({ direction: 'inflow' });
    expect(inflow.transactions.map((t: any) => t.id)).toEqual(['pay']);

    const response = await run({ direction: 'outflow', minAmount: 25.5, maxAmount: 100 });
    expect(response.transactions.map((t: any) => t.id)).toEqual(['give-1', 'split', 'give-2']);
    expect(response.totals.outflow).toBe(170.5);
  });

  it('should trim rows to the limit but total every match', async () => {
    const response = await run({ direction: 'outflow', limit: 1 });
    expect(response.transaction_count).toBe(1);
    expect(response.total_available).toBe(3);
    expect(response.totals).toEqual({ count: 3, inflow: 0, outflow: 185.5, net: -185.5 });
  });

  it('should total in the plan currency precision', async () => {
    mockApi.plans.getPlanSettingsById.mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 3 } } } });
    mockApi.transactions.getTransactions.mockResolvedValue({ data: { transactions: [txn({ amount: -1234 })] } });
    const response = await run({ direction: 'outflow' });
    expect(response.transactions[0].amount).toBe(-1.234);
    expect(response.totals.outflow).toBe(1.234);
  });

  it('should refuse contradictory bounds before any request', async () => {
    for (const input of [{ minAmount: 10, maxAmount: 5 }, { sinceDate: '2026-02-01', untilDate: '2026-01-01' }]) {
      const response = await run(input);
      expect(response.success).toBe(false);
    }
    expect(mockApi.transactions.getTransactions).not.toHaveBeenCalled();
  });

  it('should validate the new inputs', () => {
    const schema = GetTransactionsTool.inputSchema;
    expect((schema.untilDate as z.ZodType).safeParse('12/31/2026').success).toBe(false);
    expect((schema.minAmount as z.ZodType).safeParse(-1).success).toBe(false);
    expect((schema.payeeContains as z.ZodType).safeParse('').success).toBe(false);
    expect((schema.direction as z.ZodType).safeParse('sideways').success).toBe(false);
  });
});
