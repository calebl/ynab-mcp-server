import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handleAPIError, createRetryableAPICall } from "../utils/apiErrorHandler.js";
import {
  truncateResponse,
  CHARACTER_LIMIT,
  getBudgetId,
  milliUnitsToAmount,
  amountToMilliUnits,
  normalizeMonth,
  formatCurrency
} from "../utils/commonUtils.js";

interface ReconcileAccountInput {
  budgetId?: string;
  accountId?: string;
  accountName?: string;
  statementData?: string; // CSV data as string
  statementBalance?: number; // Statement ending balance in dollars
  statementDate?: string; // Statement date in YYYY-MM-DD format
  tolerance?: number; // Tolerance for matching amounts in dollars (default: 0.01)
  dryRun?: boolean;
  response_format?: "json" | "markdown";
  columnHints?: {
    dateColumn?: string;
    descriptionColumn?: string;
    amountColumn?: string;
  };
}

interface NormalizedTransaction {
  date: string;
  description: string;
  amount: number;
  raw_data: string;
}

interface ColumnDetection {
  columnName: string;
  type: 'date' | 'amount' | 'description' | 'unknown';
  confidence: number;
  sampleValues: string[];
}

interface NormalizationResult {
  success: boolean;
  transactions: NormalizedTransaction[];
  errors: string[];
  columnAnalysis: ColumnDetection[];
}

interface TransactionMatch {
  ynab_transaction_id?: string;
  ynab_date: string;
  ynab_amount: number;
  ynab_payee: string;
  ynab_memo: string;
  statement_amount?: number;
  statement_date?: string;
  statement_description?: string;
  match_type: 'exact' | 'fuzzy' | 'unmatched';
  confidence: number; // 0-1, higher = more confident match
  discrepancy?: number; // Amount difference if fuzzy match
}

interface ReconciliationResult {
  account_id: string;
  account_name: string;
  statement_balance: number;
  ynab_balance: number;
  balance_difference: number;
  statement_date: string;
  reconciliation_date: string;
  total_ynab_transactions: number;
  total_statement_transactions: number;
  exact_matches: number;
  fuzzy_matches: number;
  unmatched_ynab: number;
  unmatched_statement: number;
  matches: TransactionMatch[];
  discrepancies: {
    type: 'missing_ynab' | 'missing_statement' | 'amount_mismatch' | 'date_mismatch';
    description: string;
    amount?: number;
    transaction_id?: string;
  }[];
  summary: {
    reconciliation_status: 'balanced' | 'unbalanced' | 'needs_review';
    confidence_score: number;
    total_discrepancies: number;
    largest_discrepancy: number;
    recommendations: string[];
  };
  note: string;
}

export default class ReconcileAccountTool {
  private api: ynab.API;
  private budgetId?: string;

  constructor(budgetId?: string, ynabApi?: ynab.API) {
    this.api = ynabApi || new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = budgetId || process.env.YNAB_BUDGET_ID;
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_reconcile_account",
      description: "Reconcile a YNAB account with bank statement data. Compares YNAB transactions with statement transactions to identify discrepancies, missing transactions, and balance differences. Supports CSV statement data import.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to reconcile (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          accountId: {
            type: "string",
            description: "The ID of the account to reconcile (optional if accountName is provided)",
          },
          accountName: {
            type: "string",
            description: "The name of the account to reconcile (optional if accountId is provided). Supports partial matching.",
          },
          statementData: {
            type: "string",
            description: "CSV data from bank statement. Expected format: Date,Description,Amount (one transaction per line)",
          },
          statementBalance: {
            type: "number",
            description: "The ending balance from the bank statement in dollars (e.g., 1234.56)",
          },
          statementDate: {
            type: "string",
            description: "The statement date in YYYY-MM-DD format (e.g., '2024-03-31')",
          },
          tolerance: {
            type: "number",
            description: "Tolerance for matching amounts in dollars (default: 0.01)",
            default: 0.01,
          },
          dryRun: {
            type: "boolean",
            description: "If true, will analyze and show discrepancies without making any changes",
            default: false,
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
          columnHints: {
            type: "object",
            description: "Optional hints for CSV column mapping if auto-detection fails",
            properties: {
              dateColumn: {
                type: "string",
                description: "Name of the date column in the CSV",
              },
              descriptionColumn: {
                type: "string", 
                description: "Name of the description/payee column in the CSV",
              },
              amountColumn: {
                type: "string",
                description: "Name of the amount column in the CSV",
              },
            },
            additionalProperties: false,
          },
        },
        required: ["statementData", "statementBalance", "statementDate"],
        additionalProperties: false,
      },
      annotations: {
        title: "Reconcile Account",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    };
  }

  async execute(input: ReconcileAccountInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);

      if (!input.statementData || !input.statementBalance || !input.statementDate) {
        throw new Error("Missing required parameters: statementData, statementBalance, and statementDate are required.");
      }
      // Get all accounts
      const accountsResponse = await createRetryableAPICall(
        () => this.api.accounts.getAccounts(budgetId),
        'Get accounts for reconciliation'
      );
      const allAccounts = accountsResponse.data.accounts.filter(
        (account: any) => !account.deleted && !account.closed
      );

      // Find the target account
      let targetAccount: any = null;
      if (input.accountId) {
        targetAccount = allAccounts.find((account: any) => account.id === input.accountId);
      } else if (input.accountName) {
        // Try exact match first
        targetAccount = allAccounts.find((account: any) => 
          account.name.toLowerCase() === input.accountName!.toLowerCase()
        );
        // If no exact match, try partial match
        if (!targetAccount) {
          targetAccount = allAccounts.find((account: any) => 
            account.name.toLowerCase().includes(input.accountName!.toLowerCase())
          );
        }
      }

      if (!targetAccount) {
        throw new Error(`Account not found. Please provide a valid accountId or accountName. Use the budget_summary tool to see available accounts.`);
      }

      // Normalize statement data with intelligent parsing
      const normalizationResult = this.normalizeStatementData(input.statementData, input.columnHints);
      
      if (!normalizationResult.success) {
        const errorMessage = this.formatNormalizationError(normalizationResult);
        throw new Error(errorMessage);
      }
      
      const statementTransactions = normalizationResult.transactions;
      
      // Get YNAB transactions for the account
      const ynabTransactions = await this.getYNABTransactions(budgetId, targetAccount.id, input.statementDate);

      // Perform reconciliation
      const tolerance = input.tolerance || 0.01;
      const matches = this.matchTransactions(ynabTransactions, statementTransactions, tolerance);

      // Calculate balances and discrepancies
      const ynabBalance = milliUnitsToAmount(targetAccount.balance);
      const statementBalance = input.statementBalance;
      const balanceDifference = ynabBalance - statementBalance;

      // Analyze matches and create discrepancies
      const discrepancies = this.analyzeDiscrepancies(matches, ynabTransactions, statementTransactions);

      // Generate summary and recommendations
      const summary = this.generateSummary(matches, discrepancies, balanceDifference, tolerance);

      const result: ReconciliationResult = {
        account_id: targetAccount.id,
        account_name: targetAccount.name,
        statement_balance: statementBalance,
        ynab_balance: ynabBalance,
        balance_difference: balanceDifference,
        statement_date: input.statementDate,
        reconciliation_date: new Date().toISOString().split('T')[0],
        total_ynab_transactions: ynabTransactions.length,
        total_statement_transactions: statementTransactions.length,
        exact_matches: matches.filter(m => m.match_type === 'exact').length,
        fuzzy_matches: matches.filter(m => m.match_type === 'fuzzy').length,
        unmatched_ynab: matches.filter(m => m.match_type === 'unmatched' && m.ynab_transaction_id).length,
        unmatched_statement: matches.filter(m => m.match_type === 'unmatched' && !m.ynab_transaction_id).length,
        matches: matches,
        discrepancies: discrepancies,
        summary: summary,
        note: "All amounts are in dollars. This reconciliation compares YNAB transactions with bank statement data to identify discrepancies and missing transactions.",
      };

      const format = input.response_format || "markdown";
      let responseText: string;

      if (format === "json") {
        responseText = JSON.stringify(result, null, 2);
      } else {
        responseText = this.formatMarkdown(result);
      }

      const { text, wasTruncated } = truncateResponse(responseText, CHARACTER_LIMIT);

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };

    } catch (error) {
      await handleAPIError(error, 'Account reconciliation');
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error reconciling account: ${errorMessage}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: ReconciliationResult): string {
    let output = "# Account Reconciliation Report\n\n";

    output += "## Account Information\n";
    output += `- **Account**: ${result.account_name}\n`;
    output += `- **Statement Date**: ${result.statement_date}\n`;
    output += `- **Reconciliation Date**: ${result.reconciliation_date}\n\n`;

    output += "## Balance Summary\n";
    output += `- **Statement Balance**: ${formatCurrency(result.statement_balance)}\n`;
    output += `- **YNAB Balance**: ${formatCurrency(result.ynab_balance)}\n`;

    const balanceSymbol = result.balance_difference === 0 ? '✅' :
                          Math.abs(result.balance_difference) <= 0.01 ? '⚠️' : '❌';
    output += `- **Balance Difference**: ${formatCurrency(result.balance_difference)} ${balanceSymbol}\n\n`;

    output += "## Transaction Matching\n";
    output += `- **Total YNAB Transactions**: ${result.total_ynab_transactions}\n`;
    output += `- **Total Statement Transactions**: ${result.total_statement_transactions}\n`;
    output += `- **Exact Matches**: ${result.exact_matches} ✓\n`;
    output += `- **Fuzzy Matches**: ${result.fuzzy_matches} ~\n`;
    output += `- **Unmatched YNAB**: ${result.unmatched_ynab} ⚠️\n`;
    output += `- **Unmatched Statement**: ${result.unmatched_statement} ⚠️\n\n`;

    output += "## Reconciliation Status\n";
    const statusEmoji = result.summary.reconciliation_status === 'balanced' ? '✅' :
                        result.summary.reconciliation_status === 'needs_review' ? '⚠️' : '❌';
    output += `- **Status**: ${result.summary.reconciliation_status.toUpperCase()} ${statusEmoji}\n`;
    output += `- **Confidence Score**: ${(result.summary.confidence_score * 100).toFixed(1)}%\n`;
    output += `- **Total Discrepancies**: ${result.summary.total_discrepancies}\n`;
    output += `- **Largest Discrepancy**: ${formatCurrency(result.summary.largest_discrepancy)}\n\n`;

    if (result.summary.recommendations.length > 0) {
      output += "## Recommendations\n\n";
      for (const recommendation of result.summary.recommendations) {
        output += `- ${recommendation}\n`;
      }
      output += "\n";
    }

    if (result.discrepancies.length > 0) {
      output += "## Discrepancies\n\n";

      const missingYNAB = result.discrepancies.filter(d => d.type === 'missing_ynab');
      const missingStatement = result.discrepancies.filter(d => d.type === 'missing_statement');
      const amountMismatches = result.discrepancies.filter(d => d.type === 'amount_mismatch');

      if (missingYNAB.length > 0) {
        output += "### Missing in YNAB (found in statement)\n\n";
        for (const disc of missingYNAB) {
          output += `- ${disc.description}\n`;
        }
        output += "\n";
      }

      if (missingStatement.length > 0) {
        output += "### Missing in Statement (found in YNAB)\n\n";
        for (const disc of missingStatement) {
          output += `- ${disc.description}\n`;
        }
        output += "\n";
      }

      if (amountMismatches.length > 0) {
        output += "### Amount Mismatches\n\n";
        for (const disc of amountMismatches) {
          output += `- ${disc.description}\n`;
        }
        output += "\n";
      }
    }

    if (result.matches.length > 0 && result.exact_matches > 0) {
      output += "## Matched Transactions (Sample)\n\n";
      const exactMatches = result.matches.filter(m => m.match_type === 'exact').slice(0, 10);

      if (exactMatches.length > 0) {
        output += "### Exact Matches (showing first 10)\n\n";
        for (const match of exactMatches) {
          output += `- **${match.ynab_payee}** - ${formatCurrency(match.ynab_amount)} on ${match.ynab_date}\n`;
        }
        output += "\n";
      }
    }

    output += `## Note\n${result.note}\n`;

    return output;
  }

  private normalizeStatementData(csvData: string, hints?: {dateColumn?: string, descriptionColumn?: string, amountColumn?: string}): NormalizationResult {
    const lines = csvData.trim().split('\n');
    const errors: string[] = [];
    const columnAnalysis: ColumnDetection[] = [];
    
    if (lines.length < 2) {
      return {
        success: false,
        transactions: [],
        errors: ['CSV must have at least a header row and one data row'],
        columnAnalysis: []
      };
    }

    // Parse header row
    const headerLine = lines[0];
    const headers = this.parseCSVLine(headerLine);
    
    if (headers.length < 3) {
      return {
        success: false,
        transactions: [],
        errors: ['CSV must have at least 3 columns'],
        columnAnalysis: []
      };
    }

    // Analyze columns
    const analysis = this.analyzeColumns(headers, lines.slice(1));
    columnAnalysis.push(...analysis);

    // Use hints if provided, otherwise use auto-detection
    let dateColumnIndex = -1;
    let descriptionColumnIndex = -1;
    let amountColumnIndex = -1;

    if (hints) {
      // Use provided hints
      if (hints.dateColumn) {
        dateColumnIndex = headers.findIndex(h => h.toLowerCase().includes(hints.dateColumn!.toLowerCase()));
      }
      if (hints.descriptionColumn) {
        descriptionColumnIndex = headers.findIndex(h => h.toLowerCase().includes(hints.descriptionColumn!.toLowerCase()));
      }
      if (hints.amountColumn) {
        amountColumnIndex = headers.findIndex(h => h.toLowerCase().includes(hints.amountColumn!.toLowerCase()));
      }
    } else {
      // Auto-detect columns
      dateColumnIndex = analysis.findIndex(a => a.type === 'date' && a.confidence > 0.7);
      descriptionColumnIndex = analysis.findIndex(a => a.type === 'description' && a.confidence > 0.7);
      amountColumnIndex = analysis.findIndex(a => a.type === 'amount' && a.confidence > 0.7);
    }

    // Validate we found all required columns
    if (dateColumnIndex === -1 || descriptionColumnIndex === -1 || amountColumnIndex === -1) {
      return {
        success: false,
        transactions: [],
        errors: ['Could not identify required columns (date, description, amount)'],
        columnAnalysis: analysis
      };
    }

    // Parse data rows
    const transactions: NormalizedTransaction[] = [];
    let parseSuccessCount = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      try {
        const parts = this.parseCSVLine(line);
        
        if (parts.length < Math.max(dateColumnIndex, descriptionColumnIndex, amountColumnIndex) + 1) {
          errors.push(`Row ${i + 1}: Insufficient columns`);
          continue;
        }

        const date = this.parseDate(parts[dateColumnIndex]);
        const description = parts[descriptionColumnIndex] || '';
        let amountStr = parts[amountColumnIndex].replace(/[$,]/g, '');
        // Handle parentheses for negative amounts
        if (amountStr.startsWith('(') && amountStr.endsWith(')')) {
          amountStr = '-' + amountStr.slice(1, -1);
        }
        const amount = parseFloat(amountStr);

        if (!date || isNaN(amount) || !description) {
          errors.push(`Row ${i + 1}: Invalid data - date: ${date}, amount: ${amount}, description: "${description}"`);
          continue;
        }

        transactions.push({
          date,
          description,
          amount,
          raw_data: line
        });
        parseSuccessCount++;
      } catch (error) {
        errors.push(`Row ${i + 1}: Parse error - ${error}`);
      }
    }

    // Check if we successfully parsed enough rows
    const totalDataRows = lines.length - 1;
    const successRate = parseSuccessCount / totalDataRows;
    
    if (successRate < 0.8) {
      return {
        success: false,
        transactions: [],
        errors: [`Only ${(successRate * 100).toFixed(1)}% of rows parsed successfully (${parseSuccessCount}/${totalDataRows})`],
        columnAnalysis: analysis
      };
    }

    return {
      success: true,
      transactions,
      errors,
      columnAnalysis: analysis
    };
  }

  private analyzeColumns(headers: string[], dataRows: string[]): ColumnDetection[] {
    const analysis: ColumnDetection[] = [];
    const sampleRows = dataRows.slice(0, Math.min(10, dataRows.length));

    for (let i = 0; i < headers.length; i++) {
      const columnName = headers[i];
      const sampleValues = sampleRows.map(row => {
        const parts = this.parseCSVLine(row);
        return parts[i] || '';
      }).filter(v => v.length > 0);

      const detection = this.detectColumnType(columnName, sampleValues);
      analysis.push(detection);
    }

    return analysis;
  }

  private detectColumnType(columnName: string, sampleValues: string[]): ColumnDetection {
    const nameLower = columnName.toLowerCase();
    
    // Check for date columns
    if (nameLower.includes('date') || nameLower.includes('posted')) {
      const dateConfidence = this.calculateDateConfidence(sampleValues);
      if (dateConfidence > 0.5) {
        return {
          columnName,
          type: 'date',
          confidence: dateConfidence,
          sampleValues: sampleValues.slice(0, 3)
        };
      }
    }

    // Check for amount columns
    if (nameLower.includes('amount') || nameLower.includes('balance')) {
      const amountConfidence = this.calculateAmountConfidence(sampleValues);
      if (amountConfidence > 0.5) {
        return {
          columnName,
          type: 'amount',
          confidence: amountConfidence,
          sampleValues: sampleValues.slice(0, 3)
        };
      }
    }

    // Check for description columns
    if (nameLower.includes('description') || nameLower.includes('payee') || nameLower.includes('memo')) {
      const descriptionConfidence = this.calculateDescriptionConfidence(sampleValues);
      return {
        columnName,
        type: 'description',
        confidence: descriptionConfidence,
        sampleValues: sampleValues.slice(0, 3)
      };
    }

    // Try to detect by content
    const dateConfidence = this.calculateDateConfidence(sampleValues);
    if (dateConfidence > 0.8) {
      return {
        columnName,
        type: 'date',
        confidence: dateConfidence,
        sampleValues: sampleValues.slice(0, 3)
      };
    }

    const amountConfidence = this.calculateAmountConfidence(sampleValues);
    if (amountConfidence > 0.8) {
      return {
        columnName,
        type: 'amount',
        confidence: amountConfidence,
        sampleValues: sampleValues.slice(0, 3)
      };
    }

    // Default to description if it's the longest text field
    const avgLength = sampleValues.reduce((sum, val) => sum + val.length, 0) / sampleValues.length;
    if (avgLength > 10) {
      return {
        columnName,
        type: 'description',
        confidence: 0.6,
        sampleValues: sampleValues.slice(0, 3)
      };
    }

    return {
      columnName,
      type: 'unknown',
      confidence: 0,
      sampleValues: sampleValues.slice(0, 3)
    };
  }

  private calculateDateConfidence(values: string[]): number {
    if (values.length === 0) return 0;
    
    let validDates = 0;
    for (const value of values) {
      if (this.parseDate(value)) {
        validDates++;
      }
    }
    
    return validDates / values.length;
  }

  private calculateAmountConfidence(values: string[]): number {
    if (values.length === 0) return 0;
    
    let validAmounts = 0;
    for (const value of values) {
      const cleaned = value.replace(/[$,]/g, '');
      if (!isNaN(parseFloat(cleaned)) && (cleaned.includes('.') || cleaned.includes('-'))) {
        validAmounts++;
      }
    }
    
    return validAmounts / values.length;
  }

  private calculateDescriptionConfidence(values: string[]): number {
    if (values.length === 0) return 0;
    
    // Description columns typically have longer text and contain letters
    let validDescriptions = 0;
    for (const value of values) {
      if (value.length > 5 && /[a-zA-Z]/.test(value)) {
        validDescriptions++;
      }
    }
    
    return validDescriptions / values.length;
  }

  private formatNormalizationError(result: NormalizationResult): string {
    let error = "Unable to automatically parse bank statement CSV.\n\n";
    
    if (result.columnAnalysis.length > 0) {
      error += "Detected structure:\n";
      for (const analysis of result.columnAnalysis) {
        const confidenceStr = analysis.confidence > 0 ? ` (${analysis.type.toUpperCase()} - confidence ${Math.round(analysis.confidence * 100)}%)` : ' (unknown type)';
        error += `- Column: "${analysis.columnName}"${confidenceStr}\n`;
      }
      error += "\n";
    }

    if (result.errors.length > 0) {
      error += "Parse errors:\n";
      for (const err of result.errors.slice(0, 5)) {
        error += `- ${err}\n`;
      }
      if (result.errors.length > 5) {
        error += `- ... and ${result.errors.length - 5} more errors\n`;
      }
      error += "\n";
    }

    error += "Please provide column hints:\n";
    error += "{\n";
    error += "  \"columnHints\": {\n";
    error += "    \"dateColumn\": \"<name of date column>\",\n";
    error += "    \"descriptionColumn\": \"<name of description column>\",\n";
    error += "    \"amountColumn\": \"<name of amount column>\"\n";
    error += "  }\n";
    error += "}\n";

    return error;
  }

  private parseStatementData(csvData: string): Array<{date: string, description: string, amount: number}> {
    const lines = csvData.trim().split('\n');
    const transactions: Array<{date: string, description: string, amount: number}> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Skip header row if it looks like a header
      if (i === 0 && (line.toLowerCase().includes('date') || line.toLowerCase().includes('description') || line.toLowerCase().includes('details'))) {
        continue;
      }

      // Parse CSV line - handle both simple and complex formats
      const parts = this.parseCSVLine(line);
      
      if (parts.length >= 3) {
        try {
          // Try different column arrangements for different bank formats
          let dateIndex = -1;
          let descriptionIndex = -1;
          let amountIndex = -1;

          // Look for date column (try different positions)
          for (let j = 0; j < parts.length; j++) {
            if (this.looksLikeDate(parts[j])) {
              dateIndex = j;
              break;
            }
          }

          // Look for amount column (numeric with possible negative sign)
          for (let j = 0; j < parts.length; j++) {
            const cleaned = parts[j].replace(/[$,]/g, '');
            if (!isNaN(parseFloat(cleaned)) && (cleaned.includes('-') || cleaned.includes('.'))) {
              amountIndex = j;
              break;
            }
          }

          // Description is usually the longest text field
          let maxLength = 0;
          for (let j = 0; j < parts.length; j++) {
            if (j !== dateIndex && j !== amountIndex && parts[j].length > maxLength) {
              maxLength = parts[j].length;
              descriptionIndex = j;
            }
          }

          // Fallback: if we can't determine columns, try first 3 columns
          if (dateIndex === -1) dateIndex = 0;
          if (descriptionIndex === -1) descriptionIndex = 1;
          if (amountIndex === -1) amountIndex = 2;

          const date = this.parseDate(parts[dateIndex]);
          const description = parts[descriptionIndex] || '';
          const amount = parseFloat(parts[amountIndex].replace(/[$,]/g, ''));

          if (!isNaN(amount) && date && description) {
            transactions.push({
              date: date,
              description: description,
              amount: amount
            });
          }
        } catch (error) {
          console.warn(`Failed to parse line ${i + 1}: ${line}`);
        }
      }
    }

    return transactions;
  }

  private parseCSVLine(line: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    parts.push(current.trim());
    return parts;
  }

  private looksLikeDate(str: string): boolean {
    // Check if string looks like a date
    return /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(str) || 
           /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(str) ||
           !isNaN(Date.parse(str));
  }

  private parseDate(dateStr: string): string | null {
    try {
      // Try various date formats
      const formats = [
        /^(\d{4})-(\d{2})-(\d{2})$/, // YYYY-MM-DD
        /^(\d{2})\/(\d{2})\/(\d{4})$/, // MM/DD/YYYY
        /^(\d{2})-(\d{2})-(\d{4})$/, // MM-DD-YYYY
        /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, // M/D/YYYY
      ];

      for (const format of formats) {
        const match = dateStr.match(format);
        if (match) {
          if (format.source.includes('YYYY')) {
            // YYYY-MM-DD format
            return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
          } else {
            // MM/DD/YYYY or MM-DD-YYYY format
            return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
          }
        }
      }

      // Try parsing as Date object
      const date = new Date(dateStr);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  private async getYNABTransactions(budgetId: string, accountId: string, statementDate: string): Promise<any[]> {
    try {
      // Get transactions for the account up to the statement date
      const endDate = new Date(statementDate);
      const startDate = new Date(endDate);
      startDate.setMonth(startDate.getMonth() - 3); // Get 3 months of data

      const transactionsResponse = await createRetryableAPICall(
        () => this.api.transactions.getTransactionsByAccount(
          budgetId,
          accountId,
          startDate.toISOString().split('T')[0]
        ),
        'Get transactions for reconciliation'
      );

      return transactionsResponse.data.transactions.filter((t: any) => !t.deleted);
    } catch (error) {
      console.error('Error fetching YNAB transactions:', error);
      return [];
    }
  }

  private matchTransactions(ynabTransactions: any[], statementTransactions: NormalizedTransaction[], tolerance: number): TransactionMatch[] {
    const matches: TransactionMatch[] = [];
    const usedYNAB = new Set<string>();
    const usedStatement = new Set<number>();

    // First pass: exact matches (amount exact + date ≤ 1 day + description > 90%)
    for (const ynabTxn of ynabTransactions) {
      for (let i = 0; i < statementTransactions.length; i++) {
        const stmtTxn = statementTransactions[i];

        if (usedStatement.has(i)) continue;

        const ynabAmount = milliUnitsToAmount(ynabTxn.amount);
        const amountDiff = Math.abs(ynabAmount - stmtTxn.amount);
        const dateDiff = Math.abs(new Date(ynabTxn.date).getTime() - new Date(stmtTxn.date).getTime());
        const daysDiff = dateDiff / (1000 * 60 * 60 * 24);
        const descriptionSimilarity = this.calculateDescriptionSimilarity(
          ynabTxn.payee_name || '', 
          stmtTxn.description
        );

        // Exact match: same amount and date within 1 day and high description similarity
        if (amountDiff <= tolerance && daysDiff <= 1 && descriptionSimilarity > 0.9) {
          matches.push({
            ynab_transaction_id: ynabTxn.id,
            ynab_date: ynabTxn.date,
            ynab_amount: ynabAmount,
            ynab_payee: ynabTxn.payee_name || 'Unknown',
            ynab_memo: ynabTxn.memo || '',
            statement_amount: stmtTxn.amount,
            statement_date: stmtTxn.date,
            statement_description: stmtTxn.description,
            match_type: 'exact',
            confidence: 1.0,
          });
          usedYNAB.add(ynabTxn.id);
          usedStatement.add(i);
          break;
        }
      }
    }

    // Second pass: strong matches (amount exact + date ≤ 3 days + description > 70%)
    for (const ynabTxn of ynabTransactions) {
      if (usedYNAB.has(ynabTxn.id)) continue;

      for (let i = 0; i < statementTransactions.length; i++) {
        const stmtTxn = statementTransactions[i];

        if (usedStatement.has(i)) continue;

        const ynabAmount = milliUnitsToAmount(ynabTxn.amount);
        const amountDiff = Math.abs(ynabAmount - stmtTxn.amount);
        const dateDiff = Math.abs(new Date(ynabTxn.date).getTime() - new Date(stmtTxn.date).getTime());
        const daysDiff = dateDiff / (1000 * 60 * 60 * 24);
        const descriptionSimilarity = this.calculateDescriptionSimilarity(
          ynabTxn.payee_name || '', 
          stmtTxn.description
        );

        // Strong match: amount exact and date within 3 days and good description similarity
        if (amountDiff <= tolerance && daysDiff <= 3 && descriptionSimilarity > 0.7) {
          matches.push({
            ynab_transaction_id: ynabTxn.id,
            ynab_date: ynabTxn.date,
            ynab_amount: ynabAmount,
            ynab_payee: ynabTxn.payee_name || 'Unknown',
            ynab_memo: ynabTxn.memo || '',
            statement_amount: stmtTxn.amount,
            statement_date: stmtTxn.date,
            statement_description: stmtTxn.description,
            match_type: 'fuzzy',
            confidence: 0.8 + (descriptionSimilarity * 0.2), // 0.8-1.0 range
            discrepancy: amountDiff,
          });
          usedYNAB.add(ynabTxn.id);
          usedStatement.add(i);
          break;
        }
      }
    }

    // Third pass: fuzzy matches (amount exact + date ≤ 5 days + description > 60%)
    for (const ynabTxn of ynabTransactions) {
      if (usedYNAB.has(ynabTxn.id)) continue;

      for (let i = 0; i < statementTransactions.length; i++) {
        const stmtTxn = statementTransactions[i];

        if (usedStatement.has(i)) continue;

        const ynabAmount = milliUnitsToAmount(ynabTxn.amount);
        const amountDiff = Math.abs(ynabAmount - stmtTxn.amount);
        const dateDiff = Math.abs(new Date(ynabTxn.date).getTime() - new Date(stmtTxn.date).getTime());
        const daysDiff = dateDiff / (1000 * 60 * 60 * 24);
        const descriptionSimilarity = this.calculateDescriptionSimilarity(
          ynabTxn.payee_name || '', 
          stmtTxn.description
        );

        // Fuzzy match: amount exact and date within 5 days and moderate description similarity
        if (amountDiff <= tolerance && daysDiff <= 5 && descriptionSimilarity > 0.6) {
          matches.push({
            ynab_transaction_id: ynabTxn.id,
            ynab_date: ynabTxn.date,
            ynab_amount: ynabAmount,
            ynab_payee: ynabTxn.payee_name || 'Unknown',
            ynab_memo: ynabTxn.memo || '',
            statement_amount: stmtTxn.amount,
            statement_date: stmtTxn.date,
            statement_description: stmtTxn.description,
            match_type: 'fuzzy',
            confidence: 0.6 + (descriptionSimilarity * 0.2), // 0.6-0.8 range
            discrepancy: amountDiff,
          });
          usedYNAB.add(ynabTxn.id);
          usedStatement.add(i);
          break;
        }
      }
    }

    // Fourth pass: amount-only matches (amount exact + date ≤ 7 days, flag as low confidence)
    for (const ynabTxn of ynabTransactions) {
      if (usedYNAB.has(ynabTxn.id)) continue;

      for (let i = 0; i < statementTransactions.length; i++) {
        const stmtTxn = statementTransactions[i];

        if (usedStatement.has(i)) continue;

        const ynabAmount = milliUnitsToAmount(ynabTxn.amount);
        const amountDiff = Math.abs(ynabAmount - stmtTxn.amount);
        const dateDiff = Math.abs(new Date(ynabTxn.date).getTime() - new Date(stmtTxn.date).getTime());
        const daysDiff = dateDiff / (1000 * 60 * 60 * 24);

        // Amount-only match: amount exact and date within 7 days (low confidence)
        if (amountDiff <= tolerance && daysDiff <= 7) {
          matches.push({
            ynab_transaction_id: ynabTxn.id,
            ynab_date: ynabTxn.date,
            ynab_amount: ynabAmount,
            ynab_payee: ynabTxn.payee_name || 'Unknown',
            ynab_memo: ynabTxn.memo || '',
            statement_amount: stmtTxn.amount,
            statement_date: stmtTxn.date,
            statement_description: stmtTxn.description,
            match_type: 'fuzzy',
            confidence: 0.3, // Low confidence for amount-only matches
            discrepancy: amountDiff,
          });
          usedYNAB.add(ynabTxn.id);
          usedStatement.add(i);
          break;
        }
      }
    }

    // Fifth pass: unmatched YNAB transactions
    for (const ynabTxn of ynabTransactions) {
      if (!usedYNAB.has(ynabTxn.id)) {
        matches.push({
          ynab_transaction_id: ynabTxn.id,
          ynab_date: ynabTxn.date,
          ynab_amount: milliUnitsToAmount(ynabTxn.amount),
          ynab_payee: ynabTxn.payee_name || 'Unknown',
          ynab_memo: ynabTxn.memo || '',
          match_type: 'unmatched',
          confidence: 0,
        });
      }
    }

    // Sixth pass: unmatched statement transactions
    for (let i = 0; i < statementTransactions.length; i++) {
      if (!usedStatement.has(i)) {
        const stmtTxn = statementTransactions[i];
        matches.push({
          ynab_date: '',
          ynab_amount: 0,
          ynab_payee: '',
          ynab_memo: '',
          statement_amount: stmtTxn.amount,
          statement_date: stmtTxn.date,
          statement_description: stmtTxn.description,
          match_type: 'unmatched',
          confidence: 0,
        });
      }
    }

    return matches;
  }

  private calculateMatchConfidence(ynabTxn: any, stmtTxn: {date: string, description: string, amount: number}, amountDiff: number, daysDiff: number): number {
    let confidence = 1.0;

    // Reduce confidence based on amount difference
    confidence -= Math.min(amountDiff / 10, 0.3); // Max 30% reduction for amount

    // Reduce confidence based on date difference
    confidence -= Math.min(daysDiff / 10, 0.3); // Max 30% reduction for date

    // Reduce confidence based on description similarity (simple check)
    const ynabDesc = (ynabTxn.payee_name || '').toLowerCase();
    const stmtDesc = stmtTxn.description.toLowerCase();
    const commonWords = this.getCommonWords(ynabDesc, stmtDesc);
    if (commonWords.length === 0) {
      confidence -= 0.2; // 20% reduction if no common words
    }

    return Math.max(0, Math.min(1, confidence));
  }

  private extractKeywords(description: string): string[] {
    // Remove common banking noise terms
    const bankingTerms = [
      'web', 'id', 'ach', 'ppd', 'tel', 'payment', 'transfer', 'transaction',
      'auto', 'pay', 'credit', 'debit', 'fee', 'withdrawal', 'deposit',
      'online', 'electronic', 'wire', 'check', 'card', 'pos', 'atm',
      'td', 'amt', 'ref', 'conf', 'auth', 'app', 'mobile', 'digital',
      'inc', 'corp', 'llc', 'ltd', 'co', 'company', 'bank', 'financial'
    ];
    
    // Split on various delimiters and clean up
    const words = description
      .toLowerCase()
      .split(/[\s\-_\/\:\.]+/)
      .map(word => word.replace(/[^\w]/g, ''))
      .filter(word => word.length > 2 && !bankingTerms.includes(word))
      .filter(word => !/^\d+$/.test(word)) // Remove pure numbers
      .filter(word => word !== '');

    // Normalize common patterns
    const normalizedWords = words.map(word => {
      // Normalize common banking abbreviations
      if (word === 'gsbank') return 'apple';
      if (word === 'mercuryach') return 'mercury';
      if (word === 'privacycom') return 'privacy';
      if (word === 'chase') return 'chase';
      if (word === 'wells' || word === 'fargo') return 'wellsfargo';
      if (word === 'schwab') return 'schwab';
      if (word === 'bankamerica' || word === 'bofa') return 'bankofamerica';
      if (word === 'pwp') return 'privacy'; // PwP is Privacy.com
      
      // IMPROVED: Handle company name variations
      if (word === 'mcdonaldmazda') return 'mcdonaldmazda'; // Keep as is for partial matching
      if (word === 'hylandvillage') return 'hyland'; // Extract company name
      if (word === 'smirnovlabs') return 'smirnovlabs'; // Keep as is for partial matching
      
      return word;
    });

    // IMPROVED: Add additional keywords for better matching
    const additionalKeywords: string[] = [];
    
    // Extract company names from compound words
    normalizedWords.forEach(word => {
      if (word.includes('mcdonald') && word.includes('mazda')) {
        additionalKeywords.push('mcdonald', 'mazda');
      }
      if (word.includes('smirnov') && word.includes('labs')) {
        additionalKeywords.push('smirnov', 'labs');
      }
      if (word.includes('hyland') && word.includes('village')) {
        additionalKeywords.push('hyland', 'village');
      }
      if (word.includes('cto') && word.includes('blueprint')) {
        additionalKeywords.push('cto', 'blueprint');
      }
      if (word.includes('alpenglow') && word.includes('nexus')) {
        additionalKeywords.push('alpenglow', 'nexus');
      }
    });

    // Combine original words with additional keywords
    const allWords = [...normalizedWords, ...additionalKeywords];
    
    // Remove duplicates and return
    return [...new Set(allWords)];
  }

  private calculateDescriptionSimilarity(ynabPayee: string, bankDescription: string): number {
    const ynabKeywords = this.extractKeywords(ynabPayee);
    const bankKeywords = this.extractKeywords(bankDescription);
    
    if (ynabKeywords.length === 0 && bankKeywords.length === 0) {
      return 0.1; // Both are empty/just noise
    }
    
    if (ynabKeywords.length === 0 || bankKeywords.length === 0) {
      return 0; // One has keywords, other doesn't
    }
    
    // Calculate keyword overlap
    const commonKeywords = ynabKeywords.filter(keyword => 
      bankKeywords.includes(keyword)
    );
    
    // Calculate similarity as percentage of common keywords
    const maxKeywords = Math.max(ynabKeywords.length, bankKeywords.length);
    let similarity = maxKeywords > 0 ? commonKeywords.length / maxKeywords : 0;
    
    // IMPROVED: More generous similarity scoring
    // If we have any common keywords, boost the similarity significantly
    if (commonKeywords.length > 0 && maxKeywords > 0) {
      // Use a more generous minimum threshold
      similarity = Math.max(similarity, 0.5); // Minimum 50% if any keywords match
      
      // Additional boost for multiple keyword matches
      if (commonKeywords.length >= 2) {
        similarity = Math.max(similarity, 0.7); // Minimum 70% for 2+ keyword matches
      }
      
      // Extra boost for exact company name matches
      if (commonKeywords.length === maxKeywords) {
        similarity = 1.0; // Perfect match if all keywords match
      }
    }
    
    // IMPROVED: Expanded important words list and better boosting
    const importantWords = [
      'apple', 'amazon', 'google', 'microsoft', 'target', 'walmart', 'starbucks', 'mcdonalds',
      'mazda', 'hyland', 'smirnov', 'labs', 'privacy', 'venmo', 'discover', 'chase',
      'wellsfargo', 'schwab', 'bankofamerica', 'mercury', 'cto', 'blueprint', 'alpenglow', 'nexus'
    ];
    
    const hasImportantMatch = importantWords.some(word => 
      ynabKeywords.includes(word) && bankKeywords.includes(word)
    );
    
    if (hasImportantMatch) {
      // More generous boosting for important word matches
      if (similarity > 0.3) {
        return Math.min(1.0, similarity + 0.3); // Boost by 30% instead of 20%
      } else {
        return Math.min(1.0, similarity + 0.4); // Even bigger boost for low similarity
      }
    }
    
    // IMPROVED: Additional logic for company name variations
    // Check if one description contains the other (for cases like "Smirnov Labs" vs "Smirnov Labs LLC")
    const ynabLower = ynabPayee.toLowerCase();
    const bankLower = bankDescription.toLowerCase();
    
    if (ynabLower.includes(bankLower) || bankLower.includes(ynabLower)) {
      return Math.max(similarity, 0.8); // High similarity for substring matches
    }
    
    // Check for partial word matches (e.g., "mcdonald" vs "mcdonaldmazda")
    const hasPartialMatch = ynabKeywords.some(ynabWord => 
      bankKeywords.some(bankWord => 
        ynabWord.includes(bankWord) || bankWord.includes(ynabWord)
      )
    );
    
    if (hasPartialMatch) {
      return Math.max(similarity, 0.6); // Boost for partial word matches
    }
    
    return similarity;
  }

  private getCommonWords(str1: string, str2: string): string[] {
    const words1 = str1.split(/\s+/).filter(w => w.length > 2);
    const words2 = str2.split(/\s+/).filter(w => w.length > 2);
    return words1.filter(word => words2.includes(word));
  }

  private analyzeDiscrepancies(matches: TransactionMatch[], ynabTransactions: any[], statementTransactions: NormalizedTransaction[]): Array<{type: 'missing_ynab' | 'missing_statement' | 'amount_mismatch' | 'date_mismatch', description: string, amount?: number, transaction_id?: string}> {
    const discrepancies: Array<{type: 'missing_ynab' | 'missing_statement' | 'amount_mismatch' | 'date_mismatch', description: string, amount?: number, transaction_id?: string}> = [];

    // Find unmatched YNAB transactions
    const unmatchedYNAB = matches.filter(m => m.match_type === 'unmatched' && m.ynab_transaction_id);
    for (const match of unmatchedYNAB) {
      discrepancies.push({
        type: 'missing_statement',
        description: `YNAB transaction not found in statement: ${match.ynab_payee} - $${match.ynab_amount.toFixed(2)} on ${match.ynab_date}`,
        amount: match.ynab_amount,
        transaction_id: match.ynab_transaction_id,
      });
    }

    // Find unmatched statement transactions
    const unmatchedStatement = matches.filter(m => m.match_type === 'unmatched' && !m.ynab_transaction_id);
    for (const match of unmatchedStatement) {
      discrepancies.push({
        type: 'missing_ynab',
        description: `Statement transaction not found in YNAB: ${match.statement_description} - $${match.statement_amount?.toFixed(2)} on ${match.statement_date}`,
        amount: match.statement_amount,
      });
    }

    // Find amount mismatches
    const fuzzyMatches = matches.filter(m => m.match_type === 'fuzzy' && m.discrepancy && m.discrepancy > 0.01);
    for (const match of fuzzyMatches) {
      discrepancies.push({
        type: 'amount_mismatch',
        description: `Amount mismatch: YNAB $${match.ynab_amount.toFixed(2)} vs Statement $${match.statement_amount?.toFixed(2)} (diff: $${match.discrepancy?.toFixed(2)})`,
        amount: match.discrepancy,
        transaction_id: match.ynab_transaction_id,
      });
    }

    return discrepancies;
  }

  private generateSummary(matches: TransactionMatch[], discrepancies: Array<{type: 'missing_ynab' | 'missing_statement' | 'amount_mismatch' | 'date_mismatch', description: string, amount?: number, transaction_id?: string}>, balanceDifference: number, tolerance: number): {reconciliation_status: 'balanced' | 'unbalanced' | 'needs_review', confidence_score: number, total_discrepancies: number, largest_discrepancy: number, recommendations: string[]} {
    const exactMatches = matches.filter(m => m.match_type === 'exact').length;
    const fuzzyMatches = matches.filter(m => m.match_type === 'fuzzy').length;
    const totalMatches = exactMatches + fuzzyMatches;
    const totalTransactions = matches.length;

    // Calculate confidence score
    const confidenceScore = totalTransactions > 0 ? totalMatches / totalTransactions : 0;

    // Determine reconciliation status
    let reconciliationStatus: 'balanced' | 'unbalanced' | 'needs_review';
    if (Math.abs(balanceDifference) <= tolerance && discrepancies.length === 0) {
      reconciliationStatus = 'balanced';
    } else if (discrepancies.length <= 2 && Math.abs(balanceDifference) <= 10) {
      reconciliationStatus = 'needs_review';
    } else {
      reconciliationStatus = 'unbalanced';
    }

    // Find largest discrepancy
    const largestDiscrepancy = Math.max(
      ...discrepancies.map(d => Math.abs(d.amount || 0)),
      Math.abs(balanceDifference)
    );

    // Generate recommendations
    const recommendations: string[] = [];
    
    if (reconciliationStatus === 'balanced') {
      recommendations.push('Account is fully reconciled - no action needed');
    } else {
      if (Math.abs(balanceDifference) > tolerance) {
        recommendations.push(`Balance difference of $${balanceDifference.toFixed(2)} needs investigation`);
      }
      
      const missingYNAB = discrepancies.filter(d => d.type === 'missing_ynab').length;
      const missingStatement = discrepancies.filter(d => d.type === 'missing_statement').length;
      
      if (missingYNAB > 0) {
        recommendations.push(`${missingYNAB} statement transactions need to be added to YNAB`);
      }
      
      if (missingStatement > 0) {
        recommendations.push(`${missingStatement} YNAB transactions may need to be removed or marked as pending`);
      }
      
      if (confidenceScore < 0.8) {
        recommendations.push('Low confidence in transaction matching - manual review recommended');
      }
    }

    return {
      reconciliation_status: reconciliationStatus,
      confidence_score: confidenceScore,
      total_discrepancies: discrepancies.length,
      largest_discrepancy: largestDiscrepancy,
      recommendations: recommendations,
    };
  }
}
