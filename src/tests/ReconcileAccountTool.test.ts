import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { z } from 'zod';
import * as ReconcileAccountTool from '../tools/ReconcileAccountTool';

describe('ReconcileAccountTool', () => {
  let mockApi: {
    accounts: { getAccountById: Mock };
    transactions: { getTransactionsByAccount: Mock; createTransaction: Mock; updateTransactions: Mock };
  };

  const account = { id: 'acct-1', name: 'Checking', type: 'checking', closed: false, deleted: false, cleared_balance: 990000 };

  const row = (id: string, cleared: string, deleted = false) => ({
    id, cleared, deleted, date: '2026-10-01', amount: -5000, payee_name: 'Shop', memo: null,
  });
  const transactions = [
    row('t-cleared', 'cleared'),
    row('t-uncleared', 'uncleared'),
    row('t-reconciled', 'reconciled'),
    row('t-deleted', 'cleared', true),
  ];
  const withoutCleared = transactions.filter((t) => t.id !== 't-cleared');

  const run = async (input: Record<string, unknown>) => {
    const result = await ReconcileAccountTool.execute({ accountId: 'acct-1', ...input } as any, mockApi as any);
    return JSON.parse(result.content[0].text);
  };

  const expectNoWrites = () => {
    expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
    expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
  };

  const withAccount = (overrides: Record<string, unknown>) =>
    mockApi.accounts.getAccountById.mockResolvedValue({ data: { account: { ...account, ...overrides } } });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));

    mockApi = {
      accounts: { getAccountById: vi.fn().mockResolvedValue({ data: { account } }) },
      transactions: {
        getTransactionsByAccount: vi.fn().mockResolvedValue({ data: { transactions } }),
        createTransaction: vi.fn(),
        updateTransactions: vi.fn(),
      },
    };

    delete process.env.YNAB_PLAN_ID;
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('read-only paths', () => {
    it('requires accountId and statementBalance and validates adjustmentDate', () => {
      const schema = z.object(ReconcileAccountTool.inputSchema);

      expect(schema.safeParse({ statementBalance: 1 }).success).toBe(false);
      expect(schema.safeParse({ accountId: 'a' }).success).toBe(false);
      expect(schema.safeParse({ accountId: 'a', statementBalance: 1, adjustmentDate: '2026-1-5' }).success).toBe(false);
      expect(schema.safeParse({ accountId: 'a', statementBalance: 1 }).success).toBe(true);
    });

    it('reads the account and all of its history and computes the difference', async () => {
      const response = await run({ statementBalance: 1000 });

      expect(mockApi.accounts.getAccountById).toHaveBeenCalledWith('test-budget-id', 'acct-1');
      expect(mockApi.transactions.getTransactionsByAccount).toHaveBeenCalledWith('test-budget-id', 'acct-1', '1970-01-01');
      expect(response.difference).toBe(10);
    });

    it('defaults to a dry run that selects only cleared, non-deleted rows and writes nothing', async () => {
      const response = await run({ statementBalance: 1000 });

      expect(response.success).toBe(true);
      expect(response.dry_run).toBe(true);
      expect(response.statement_balance).toBe(1000);
      expect(response.cleared_balance).toBe(990);
      expect(response.difference).toBe(10);
      expect(response.transactions_to_reconcile.map((t: { id: string }) => t.id)).toEqual(['t-cleared']);
      expect(response.reconcile_count).toBe(1);
      expect(response.adjustment_needed).toBe(true);
      expect(response.adjustment).toEqual({ amount: 10, date: '2026-10-13', payee_name: 'Reconciliation Balance Adjustment' });
      expectNoWrites();
    });

    it('reports no adjustment in a dry run when the statement matches', async () => {
      const response = await run({ statementBalance: 990 });

      expect(response.adjustment_needed).toBe(false);
      expect(response.adjustment).toBeNull();
      expectNoWrites();
    });

    it('makes no write call when the balance matches and nothing is cleared', async () => {
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: withoutCleared } });

      const response = await run({ dryRun: false, statementBalance: 990 });

      expect(response.success).toBe(true);
      expect(response.reconciled_count).toBe(0);
      expectNoWrites();
    });

    it('refuses a mismatch without createAdjustment and changes nothing', async () => {
      const response = await run({ dryRun: false, statementBalance: 1000 });

      expect(response.success).toBe(false);
      expect(response.error).toContain('$10.00');
      expect(response.error).toContain('Nothing was changed');
      expectNoWrites();
    });

    it('refuses a deleted account before reading transactions', async () => {
      withAccount({ deleted: true });

      const response = await run({ dryRun: false, statementBalance: 990 });

      expect(response.success).toBe(false);
      expect(mockApi.transactions.getTransactionsByAccount).not.toHaveBeenCalled();
      expectNoWrites();
    });

    it('refuses a closed account before reading transactions', async () => {
      withAccount({ closed: true });

      const response = await run({ dryRun: false, statementBalance: 990 });

      expect(response.success).toBe(false);
      expect(response.error).toContain('closed');
      expect(mockApi.transactions.getTransactionsByAccount).not.toHaveBeenCalled();
      expectNoWrites();
    });

    it('refuses a future adjustmentDate when an adjustment is needed, even in a dry run', async () => {
      const response = await run({ statementBalance: 1000, adjustmentDate: '2026-10-14' });

      expect(response.success).toBe(false);
      expect(response.error).toContain('after today');
      expectNoWrites();
    });

    it('ignores a future adjustmentDate when no adjustment is needed', async () => {
      const response = await run({ statementBalance: 990, adjustmentDate: '2026-10-14' });

      expect(response.success).toBe(true);
      expect(response.adjustment_needed).toBe(false);
    });

    it('compares in integer milliunits and signs the adjustment by direction', async () => {
      withAccount({ cleared_balance: -250500 });
      const exact = await run({ statementBalance: -250.5 });
      expect(exact.adjustment_needed).toBe(false);

      withAccount({ cleared_balance: 100010 });
      const outflow = await run({ statementBalance: 100 });
      expect(outflow.adjustment_needed).toBe(true);
      expect(outflow.adjustment.amount).toBe(-0.01);
    });

    it('returns success false with the message when reading the account fails', async () => {
      mockApi.accounts.getAccountById.mockRejectedValue(new Error('API Error'));

      const response = await run({ statementBalance: 1000 });

      expect(response.success).toBe(false);
      expect(response.error).toBe('API Error');
      expectNoWrites();
    });
  });

  describe('write paths', () => {
    const adjustment = { id: 'adj-1', date: '2026-10-13', amount: 10000, payee_name: 'Reconciliation Balance Adjustment' };

    const resolveCreate = () =>
      mockApi.transactions.createTransaction.mockResolvedValue({ data: { transaction: adjustment } });
    const resolvePatch = (ids: string[]) =>
      mockApi.transactions.updateTransactions.mockResolvedValue({ data: { transactions: ids.map((id) => ({ id })) } });
    const patchedIds = () =>
      mockApi.transactions.updateTransactions.mock.calls[0][1].transactions.map((t: { id: string }) => t.id);

    it('marks the cleared rows reconciled in one call when the balance matches', async () => {
      resolvePatch(['t-cleared']);

      const response = await run({ dryRun: false, statementBalance: 990 });

      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledTimes(1);
      expect(mockApi.transactions.updateTransactions).toHaveBeenCalledWith('test-budget-id', {
        transactions: [{ id: 't-cleared', cleared: 'reconciled' }],
      });
      expect(mockApi.transactions.createTransaction).not.toHaveBeenCalled();
      expect(response.success).toBe(true);
      expect(response.reconciled_count).toBe(1);
      expect(response.adjustment_transaction).toBeNull();
    });

    it('creates the adjustment first, then reconciles it with the cleared rows', async () => {
      resolveCreate();
      resolvePatch(['t-cleared', 'adj-1']);

      const response = await run({ dryRun: false, statementBalance: 1000, createAdjustment: true });

      expect(mockApi.transactions.createTransaction).toHaveBeenCalledWith('test-budget-id', {
        transaction: {
          account_id: 'acct-1',
          date: '2026-10-13',
          amount: 10000,
          payee_name: 'Reconciliation Balance Adjustment',
          cleared: 'cleared',
          approved: true,
        },
      });
      expect(patchedIds()).toEqual(['t-cleared', 'adj-1']);
      expect(mockApi.transactions.createTransaction.mock.invocationCallOrder[0])
        .toBeLessThan(mockApi.transactions.updateTransactions.mock.invocationCallOrder[0]);
      expect(response.success).toBe(true);
      expect(response.adjustment_transaction.amount).toBe(10);

      const totalCalls = mockApi.accounts.getAccountById.mock.calls.length
        + mockApi.transactions.getTransactionsByAccount.mock.calls.length
        + mockApi.transactions.createTransaction.mock.calls.length
        + mockApi.transactions.updateTransactions.mock.calls.length;
      expect(totalCalls).toBe(4);
    });

    it('dates the adjustment with adjustmentDate when given', async () => {
      resolveCreate();
      resolvePatch(['t-cleared', 'adj-1']);

      await run({ dryRun: false, statementBalance: 1000, createAdjustment: true, adjustmentDate: '2026-09-30' });

      expect(mockApi.transactions.createTransaction.mock.calls[0][1].transaction.date).toBe('2026-09-30');
    });

    it('does not reconcile anything when creating the adjustment fails', async () => {
      mockApi.transactions.createTransaction.mockRejectedValue(new Error('boom'));

      const response = await run({ dryRun: false, statementBalance: 1000, createAdjustment: true });

      expect(response.success).toBe(false);
      expect(response.error).toContain('boom');
      expect(response.error).toContain('Nothing was changed');
      expect(mockApi.transactions.updateTransactions).not.toHaveBeenCalled();
    });

    it('reports a partial result naming the adjustment when reconciling fails after it', async () => {
      resolveCreate();
      mockApi.transactions.updateTransactions.mockRejectedValue(new Error('patch failed'));

      const response = await run({ dryRun: false, statementBalance: 1000, createAdjustment: true });

      expect(response.success).toBe(false);
      expect(response.partial).toBe(true);
      expect(response.error).toBe('patch failed');
      expect(response.adjustment_transaction.id).toBe('adj-1');
      expect(response.message).toContain('Run again');
    });

    it('reconciles only the adjustment when no rows are cleared', async () => {
      mockApi.transactions.getTransactionsByAccount.mockResolvedValue({ data: { transactions: withoutCleared } });
      resolveCreate();
      resolvePatch(['adj-1']);

      await run({ dryRun: false, statementBalance: 1000, createAdjustment: true });

      expect(patchedIds()).toEqual(['adj-1']);
    });
  });
});
