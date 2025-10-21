import { describe, it, expect, beforeEach, vi } from 'vitest';
import ReconcileAccountTool from '../tools/ReconcileAccountTool.js';

// Mock YNAB API
const mockYNABApi = {
      accounts: {
        getAccounts: vi.fn(),
      },
      transactions: {
        getTransactionsByAccount: vi.fn(),
      },
    };

describe('ReconcileAccountTool', () => {
  let tool: ReconcileAccountTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new ReconcileAccountTool('test-budget-id', mockYNABApi as any);
  });

  describe('CSV Normalization', () => {
    it('should parse Chase bank format correctly', () => {
      const chaseCSV = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,10/20/2025,"PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084",-99.80,MISC_DEBIT,7139.41,,
CREDIT,10/17/2025,"Online Transfer from CHK ...3515 transaction#: 26622174224",4000.00,ACCT_XFER,7239.21,,`;

      const result = (tool as any).normalizeStatementData(chaseCSV);
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]).toMatchObject({
        date: '2025-10-20',
        description: 'PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084',
        amount: -99.80,
      });
      expect(result.transactions[1]).toMatchObject({
        date: '2025-10-17',
        description: 'Online Transfer from CHK ...3515 transaction#: 26622174224',
        amount: 4000.00,
      });
    });

    it('should parse Wells Fargo format correctly', () => {
      const wellsCSV = `Date,Amount,*,*,Description
10/20/2025,-99.80,,,"Privacy.com Payment"
10/17/2025,4000.00,,,"Online Transfer"`;

      const result = (tool as any).normalizeStatementData(wellsCSV);
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]).toMatchObject({
        date: '2025-10-20',
        description: 'Privacy.com Payment',
        amount: -99.80,
      });
    });

    it('should parse Schwab format correctly', () => {
      const schwabCSV = `Date,Action,Symbol,Description,Amount
10/20/2025,DEPOSIT,,"Privacy.com Payment",-99.80
10/17/2025,TRANSFER,,"Online Transfer",4000.00`;

      const result = (tool as any).normalizeStatementData(schwabCSV);
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]).toMatchObject({
        date: '2025-10-20',
        description: 'Privacy.com Payment',
        amount: -99.80,
      });
    });

    it('should parse Bank of America format correctly', () => {
      const boaCSV = `Posted Date,Payee,Address,Amount
10/20/2025,Privacy.com,,$99.80
10/17/2025,Online Transfer,,-$4000.00`;

      const result = (tool as any).normalizeStatementData(boaCSV);
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]).toMatchObject({
        date: '2025-10-20',
        description: 'Privacy.com',
        amount: 99.80,
      });
      expect(result.transactions[1]).toMatchObject({
        date: '2025-10-17',
        description: 'Online Transfer',
        amount: -4000.00,
      });
    });

    it('should parse simple format correctly', () => {
      const simpleCSV = `Date,Description,Amount
10/20/2025,Privacy.com Payment,-99.80
10/17/2025,Online Transfer,4000.00`;

      const result = (tool as any).normalizeStatementData(simpleCSV);
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]).toMatchObject({
        date: '2025-10-20',
        description: 'Privacy.com Payment',
        amount: -99.80,
      });
    });

    it('should use column hints when provided', () => {
      const csv = `Custom Date,Custom Desc,Custom Amount
10/20/2025,Test Payment,-99.80`;

      const result = (tool as any).normalizeStatementData(csv, {
        dateColumn: 'Custom Date',
        descriptionColumn: 'Custom Desc',
        amountColumn: 'Custom Amount'
      });
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        date: '2025-10-20',
        description: 'Test Payment',
        amount: -99.80,
      });
    });

    it('should handle negative amounts in parentheses', () => {
      const csv = `Date,Description,Amount
10/20/2025,Test Payment,($99.80)`;

      const result = (tool as any).normalizeStatementData(csv);
      
      expect(result.success).toBe(true);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amount).toBe(-99.80);
    });

    it('should fail with insufficient data', () => {
      const csv = `Date,Description
10/20/2025,Test Payment`;

      const result = (tool as any).normalizeStatementData(csv);
      
      expect(result.success).toBe(false);
      expect(result.errors).toContain('Could not identify required columns (date, description, amount)');
    });

    it('should provide helpful error messages with column analysis', () => {
      const csv = `Unknown1,Unknown2,Unknown3
10/20/2025,Test Payment,99.80`;

      const result = (tool as any).normalizeStatementData(csv);
      
      expect(result.success).toBe(false);
      expect(result.columnAnalysis).toHaveLength(3);
      expect(result.columnAnalysis[0].type).toBe('date');
      expect(result.columnAnalysis[1].type).toBe('description');
      expect(result.columnAnalysis[2].type).toBe('amount');
    });
  });

  describe('Keyword Extraction', () => {
    it('should extract meaningful keywords from bank descriptions', () => {
      const keywords = (tool as any).extractKeywords('PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084');
      
      expect(keywords).toContain('privacy');
      expect(keywords).not.toContain('web');
      expect(keywords).not.toContain('id');
      expect(keywords).not.toContain('5199481');
    });

    it('should normalize common banking abbreviations', () => {
      const keywords = (tool as any).extractKeywords('APPLECARD GSBANK PAYMENT');
      
      expect(keywords).toContain('apple');
      expect(keywords).not.toContain('gsbank');
    });

    it('should handle YNAB payee names', () => {
      const keywords = (tool as any).extractKeywords('Privacy - Lena Telegram');
      
      expect(keywords).toContain('privacy');
      expect(keywords).toContain('lena');
      expect(keywords).toContain('telegram');
    });
  });

  describe('Description Similarity', () => {
    it('should find high similarity between related descriptions', () => {
      const similarity = (tool as any).calculateDescriptionSimilarity(
        'Privacy - Lena Telegram',
        'PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084'
      );
      
      expect(similarity).toBeGreaterThan(0.3);
    });

    it('should find low similarity between unrelated descriptions', () => {
      const similarity = (tool as any).calculateDescriptionSimilarity(
        'Apple Store',
        'McDonald\'s Restaurant'
      );
      
      expect(similarity).toBeLessThan(0.5);
    });

    it('should boost similarity for important merchant matches', () => {
      const similarity = (tool as any).calculateDescriptionSimilarity(
        'Apple Store Purchase',
        'APPLECARD GSBANK PAYMENT'
      );
      
      expect(similarity).toBeGreaterThan(0.5);
    });
  });

  describe('Transaction Matching', () => {
    const mockYNABTransactions = [
      {
        id: 'ynab-1',
        date: '2025-10-20',
        amount: -99800, // -99.80 in milliunits
        payee_name: 'Privacy - Lena Telegram',
        memo: 'Test memo'
      },
      {
        id: 'ynab-2',
        date: '2025-10-17',
        amount: 4000000, // 4000.00 in milliunits
        payee_name: 'Online Transfer',
        memo: ''
      }
    ];

    const mockStatementTransactions = [
      {
        date: '2025-10-20',
        description: 'PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084',
        amount: -99.80,
        raw_data: 'DEBIT,10/20/2025,"PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084",-99.80,MISC_DEBIT,7139.41,,'
      },
      {
        date: '2025-10-17',
        description: 'Online Transfer from CHK ...3515 transaction#: 26622174224',
        amount: 4000.00,
        raw_data: 'CREDIT,10/17/2025,"Online Transfer from CHK ...3515 transaction#: 26622174224",4000.00,ACCT_XFER,7239.21,,'
      }
    ];

    it('should find exact matches', () => {
      const matches = (tool as any).matchTransactions(mockYNABTransactions, mockStatementTransactions, 0.01);
      
      const exactMatches = matches.filter(m => m.match_type === 'exact');
      expect(exactMatches.length).toBeGreaterThan(0);
      
      const privacyMatch = exactMatches.find(m => m.ynab_transaction_id === 'ynab-1');
      expect(privacyMatch).toBeDefined();
      expect(privacyMatch?.confidence).toBe(1.0);
    });

    it('should find fuzzy matches with date tolerance', () => {
      const ynabTxn = [{
        id: 'ynab-1',
        date: '2025-10-18', // 2 days after statement date
        amount: -99800,
        payee_name: 'Privacy - Lena Telegram',
        memo: ''
      }];

      const stmtTxn = [{
        date: '2025-10-20',
        description: 'PwP  Privacy.com Privacycom TN: 5199481     WEB ID:  626060084',
        amount: -99.80,
        raw_data: 'test'
      }];

      const matches = (tool as any).matchTransactions(ynabTxn, stmtTxn, 0.01);
      
      const fuzzyMatches = matches.filter(m => m.match_type === 'fuzzy');
      expect(fuzzyMatches.length).toBeGreaterThan(0);
      expect(fuzzyMatches[0].confidence).toBeGreaterThan(0.3);
    });

    it('should handle unmatched transactions', () => {
      const ynabTxn = [{
        id: 'ynab-1',
        date: '2025-10-20',
        amount: -99800,
        payee_name: 'Unmatched YNAB Transaction',
        memo: ''
      }];

      const stmtTxn = [{
        date: '2025-10-20',
        description: 'Completely Different Transaction',
        amount: -50.00,
        raw_data: 'test'
      }];

      const matches = (tool as any).matchTransactions(ynabTxn, stmtTxn, 0.01);
      
      const unmatched = matches.filter(m => m.match_type === 'unmatched');
      expect(unmatched.length).toBe(2); // One from each side
    });
  });

  describe('Error Handling', () => {
    it('should handle missing account', async () => {
      mockYNABApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [] }
      });

      const result = await tool.execute({
        statementData: 'Date,Description,Amount\n10/20/2025,Test,-99.80',
        statementBalance: 1000.00,
        statementDate: '2025-10-20',
        accountName: 'Nonexistent Account'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Account not found');
    });

    it('should handle CSV parsing errors gracefully', async () => {
      mockYNABApi.accounts.getAccounts.mockResolvedValue({
        data: { accounts: [{ id: 'test-account', name: 'Test Account', balance: 100000 }] }
      });

      const result = await tool.execute({
        statementData: 'Invalid CSV data',
        statementBalance: 1000.00,
        statementDate: '2025-10-20',
        accountName: 'Test Account'
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unable to automatically parse');
    });
  });
});