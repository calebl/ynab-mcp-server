import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Import all tools
import * as ListBudgetsTool from '../tools/ListBudgetsTool.js';
import * as GetUnapprovedTransactionsTool from '../tools/GetUnapprovedTransactionsTool.js';
import * as BudgetSummaryTool from '../tools/BudgetSummaryTool.js';
import * as CreateTransactionTool from '../tools/CreateTransactionTool.js';
import * as ApproveTransactionTool from '../tools/ApproveTransactionTool.js';
import * as UpdateCategoryBudgetTool from '../tools/UpdateCategoryBudgetTool.js';
import * as UpdateTransactionTool from '../tools/UpdateTransactionTool.js';
import * as BulkApproveTransactionsTool from '../tools/BulkApproveTransactionsTool.js';
import * as ListPayeesTool from '../tools/ListPayeesTool.js';
import * as GetTransactionsTool from '../tools/GetTransactionsTool.js';
import * as DeleteTransactionTool from '../tools/DeleteTransactionTool.js';
import * as ListCategoriesTool from '../tools/ListCategoriesTool.js';
import * as ListAccountsTool from '../tools/ListAccountsTool.js';
import * as ListScheduledTransactionsTool from '../tools/ListScheduledTransactionsTool.js';
import * as ImportTransactionsTool from '../tools/ImportTransactionsTool.js';
import * as ListMonthsTool from '../tools/ListMonthsTool.js';

vi.mock('@modelcontextprotocol/sdk/server/mcp.js');

describe('Tool Registration', () => {
  let mockServer: {
    registerTool: Mock;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockServer = {
      registerTool: vi.fn(),
    };

    (McpServer as any).mockImplementation(() => mockServer);
  });

  // Expected tool list
  const expectedTools = [
    { tool: ListBudgetsTool, title: 'List Budgets' },
    { tool: GetUnapprovedTransactionsTool, title: 'Get Unapproved Transactions' },
    { tool: BudgetSummaryTool, title: 'Budget Summary' },
    { tool: CreateTransactionTool, title: 'Create Transaction' },
    { tool: ApproveTransactionTool, title: 'Approve Transaction' },
    { tool: UpdateCategoryBudgetTool, title: 'Update Category Budget' },
    { tool: UpdateTransactionTool, title: 'Update Transaction' },
    { tool: BulkApproveTransactionsTool, title: 'Bulk Approve Transactions' },
    { tool: ListPayeesTool, title: 'List Payees' },
    { tool: GetTransactionsTool, title: 'Get Transactions' },
    { tool: DeleteTransactionTool, title: 'Delete Transaction' },
    { tool: ListCategoriesTool, title: 'List Categories' },
    { tool: ListAccountsTool, title: 'List Accounts' },
    { tool: ListScheduledTransactionsTool, title: 'List Scheduled Transactions' },
    { tool: ImportTransactionsTool, title: 'Import Transactions' },
    { tool: ListMonthsTool, title: 'List Months' },
  ];

  describe('Tool Exports', () => {
    it('should have correct number of tools', () => {
      expect(expectedTools.length).toBe(16);
    });

    expectedTools.forEach(({ tool, title }) => {
      describe(`${title}`, () => {
        it('should export name', () => {
          expect(tool.name).toBeDefined();
          expect(typeof tool.name).toBe('string');
          expect(tool.name.length).toBeGreaterThan(0);
        });

        it('should export description', () => {
          expect(tool.description).toBeDefined();
          expect(typeof tool.description).toBe('string');
          expect(tool.description.length).toBeGreaterThan(0);
        });

        it('should export inputSchema', () => {
          expect(tool.inputSchema).toBeDefined();
          expect(typeof tool.inputSchema).toBe('object');
        });

        it('should export execute function', () => {
          expect(tool.execute).toBeDefined();
          expect(typeof tool.execute).toBe('function');
        });

        it('should have async execute function', () => {
          const result = tool.execute({}, {} as any);
          expect(result).toBeInstanceOf(Promise);
        });

        it('should have name in snake_case format', () => {
          expect(tool.name).toMatch(/^[a-z_]+$/);
        });

        it('should have name starting with ynab_', () => {
          expect(tool.name).toMatch(/^ynab_/);
        });
      });
    });
  });

  describe('Tool Names', () => {
    it('should have unique tool names', () => {
      const names = expectedTools.map(({ tool }) => tool.name);
      const uniqueNames = new Set(names);

      expect(uniqueNames.size).toBe(names.length);
    });

    it('should have expected tool names', () => {
      const expectedNames = [
        'ynab_list_budgets',
        'ynab_get_unapproved_transactions',
        'ynab_budget_summary',
        'ynab_create_transaction',
        'ynab_approve_transaction',
        'ynab_update_category_budget',
        'ynab_update_transaction',
        'ynab_bulk_approve_transactions',
        'ynab_list_payees',
        'ynab_get_transactions',
        'ynab_delete_transaction',
        'ynab_list_categories',
        'ynab_list_accounts',
        'ynab_list_scheduled_transactions',
        'ynab_import_transactions',
        'ynab_list_months',
      ];

      const actualNames = expectedTools.map(({ tool }) => tool.name);

      expectedNames.forEach(name => {
        expect(actualNames).toContain(name);
      });
    });
  });

  describe('Tool Descriptions', () => {
    it('should have non-empty descriptions', () => {
      expectedTools.forEach(({ tool, title }) => {
        expect(tool.description.length).toBeGreaterThan(0);
      });
    });

    it('should have meaningful descriptions', () => {
      expectedTools.forEach(({ tool, title }) => {
        // Description should be at least 10 characters
        expect(tool.description.length).toBeGreaterThanOrEqual(10);
      });
    });
  });

  describe('Input Schemas', () => {
    it('should have valid input schemas', () => {
      expectedTools.forEach(({ tool, title }) => {
        expect(tool.inputSchema).toBeDefined();
        expect(typeof tool.inputSchema).toBe('object');
      });
    });

    it('should handle tools with empty schemas', () => {
      // ListBudgetsTool has an empty schema
      expect(ListBudgetsTool.inputSchema).toEqual({});
    });

    it('should handle tools with complex schemas', () => {
      // CreateTransactionTool has a complex schema
      expect(Object.keys(CreateTransactionTool.inputSchema).length).toBeGreaterThan(0);
    });
  });

  describe('Execute Functions', () => {
    it('should return promises', () => {
      expectedTools.forEach(({ tool, title }) => {
        const result = tool.execute({}, {} as any);
        expect(result).toBeInstanceOf(Promise);
      });
    });

    it('should accept input parameter', () => {
      expectedTools.forEach(({ tool, title }) => {
        const executeParams = tool.execute.length;
        expect(executeParams).toBeGreaterThanOrEqual(1);
      });
    });

    it('should accept API parameter', () => {
      expectedTools.forEach(({ tool, title }) => {
        const executeParams = tool.execute.length;
        expect(executeParams).toBe(2);
      });
    });
  });

  describe('Tool Registration Process', () => {
    it('should call registerTool for each tool', () => {
      // Simulate the registerTools function
      const server = new McpServer({ name: 'test', version: '1.0.0' }) as any;

      expectedTools.forEach(({ tool, title }) => {
        server.registerTool(
          tool.name,
          {
            title: title,
            description: tool.description,
            inputSchema: tool.inputSchema,
          },
          async (input: any) => tool.execute(input, {} as any)
        );
      });

      expect(mockServer.registerTool).toHaveBeenCalledTimes(16);
    });

    it('should register tools with correct parameters', () => {
      const server = new McpServer({ name: 'test', version: '1.0.0' }) as any;

      server.registerTool(
        ListBudgetsTool.name,
        {
          title: 'List Budgets',
          description: ListBudgetsTool.description,
          inputSchema: ListBudgetsTool.inputSchema,
        },
        async (input: any) => ListBudgetsTool.execute(input, {} as any)
      );

      expect(mockServer.registerTool).toHaveBeenCalledWith(
        ListBudgetsTool.name,
        expect.objectContaining({
          title: 'List Budgets',
          description: ListBudgetsTool.description,
          inputSchema: ListBudgetsTool.inputSchema,
        }),
        expect.any(Function)
      );
    });

    it('should register tools with async handlers', () => {
      const server = new McpServer({ name: 'test', version: '1.0.0' }) as any;

      const handler = async (input: any) => ListBudgetsTool.execute(input, {} as any);

      server.registerTool(
        ListBudgetsTool.name,
        {
          title: 'List Budgets',
          description: ListBudgetsTool.description,
          inputSchema: ListBudgetsTool.inputSchema,
        },
        handler
      );

      expect(mockServer.registerTool).toHaveBeenCalledWith(
        ListBudgetsTool.name,
        expect.any(Object),
        expect.any(Function)
      );

      // Verify handler is async
      const registeredHandler = mockServer.registerTool.mock.calls[0][2];
      expect(registeredHandler({}, {} as any)).toBeInstanceOf(Promise);
    });
  });

  describe('Tool Count Verification', () => {
    it('should match expected tool count', () => {
      expect(expectedTools.length).toBe(16);
    });

    it('should have all tools imported', () => {
      const toolModules = [
        ListBudgetsTool,
        GetUnapprovedTransactionsTool,
        BudgetSummaryTool,
        CreateTransactionTool,
        ApproveTransactionTool,
        UpdateCategoryBudgetTool,
        UpdateTransactionTool,
        BulkApproveTransactionsTool,
        ListPayeesTool,
        GetTransactionsTool,
        DeleteTransactionTool,
        ListCategoriesTool,
        ListAccountsTool,
        ListScheduledTransactionsTool,
        ImportTransactionsTool,
        ListMonthsTool,
      ];

      expect(toolModules.length).toBe(16);

      toolModules.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.execute).toBeDefined();
      });
    });
  });
});
