import * as ynab from "ynab";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { truncateResponse, CHARACTER_LIMIT, getBudgetId, milliUnitsToAmount, formatCurrency } from "../utils/commonUtils.js";
import { createRetryableAPICall } from "../utils/apiErrorHandler.js";

interface NetWorthAnalysisInput {
  budgetId?: string;
  response_format?: "json" | "markdown";
}

interface AccountSummary {
  id: string;
  name: string;
  type: string;
  on_budget: boolean;
  balance: number;
  balance_dollars: number;
  category: 'assets' | 'liabilities';
}

interface NetWorthAnalysisResult {
  current_net_worth: number;
  total_assets: number;
  total_liabilities: number;
  account_breakdown: {
    assets: AccountSummary[];
    liabilities: AccountSummary[];
  };
  insights: string[];
  note: string;
}

class NetWorthAnalysisTool {
  private api: ynab.API;
  private budgetId: string;

  constructor() {
    this.api = new ynab.API(process.env.YNAB_API_TOKEN || "");
    this.budgetId = process.env.YNAB_BUDGET_ID || "";
  }

  getToolDefinition(): Tool {
    return {
      name: "ynab_net_worth_analysis",
      description: "Get current net worth snapshot across all accounts (on-budget and tracking). Note: This tool only provides current balances, not historical trends due to YNAB API limitations.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: {
            type: "string",
            description: "The ID of the budget to analyze (optional, defaults to the budget set in the YNAB_BUDGET_ID environment variable)",
          },
          response_format: {
            type: "string",
            enum: ["json", "markdown"],
            description: "Response format: 'json' for machine-readable output, 'markdown' for human-readable output (default: markdown)",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Net Worth Analysis",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    };
  }

  async execute(input: NetWorthAnalysisInput) {
    try {
      const budgetId = getBudgetId(input.budgetId || this.budgetId);
      console.error(`Getting current net worth for budget ${budgetId}`);

      // Get all accounts (both on-budget and tracking)
      const accountsResponse = await createRetryableAPICall(
        () => this.api.accounts.getAccounts(budgetId),
        'Get accounts for net worth'
      );
      const allAccounts = accountsResponse.data.accounts.filter(
        (account) => account.deleted === false
      );

      // Categorize accounts and calculate current balances
      const accountSummaries: AccountSummary[] = allAccounts.map(account => {
        const balance = account.balance;
        const balanceDollars = milliUnitsToAmount(balance);
        
        // Categorize accounts as assets or liabilities
        let category: 'assets' | 'liabilities';
        if (account.type === 'creditCard' || account.type === 'mortgage' || account.type === 'otherDebt' || account.type === 'autoLoan' || account.type === 'personalLoan' || account.type === 'studentLoan' || account.type === 'medicalDebt' || account.type === 'otherLiability' || account.type === 'lineOfCredit') {
          category = 'liabilities';
        } else {
          category = 'assets';
        }
        
        return {
          id: account.id,
          name: account.name,
          type: account.type,
          on_budget: account.on_budget,
          balance: balance,
          balance_dollars: balanceDollars,
          category: category
        };
      });

      const assets = accountSummaries.filter(acc => acc.category === 'assets');
      const liabilities = accountSummaries.filter(acc => acc.category === 'liabilities');
      
      const totalAssets = assets.reduce((sum, acc) => sum + acc.balance, 0);
      const totalLiabilities = liabilities.reduce((sum, acc) => sum + acc.balance, 0);
      const netWorth = totalAssets + totalLiabilities; // Liabilities are negative

      // Generate insights
      const insights: string[] = [];
      
      // Add account-specific insights
      const largestAssets = assets
        .sort((a, b) => b.balance_dollars - a.balance_dollars)
        .slice(0, 3);

      if (largestAssets.length > 0) {
        insights.push(`Your largest assets: ${largestAssets.map(acc => `${acc.name} (${formatCurrency(acc.balance_dollars)})`).join(', ')}`);
      }

      const largestLiabilities = liabilities
        .sort((a, b) => Math.abs(b.balance_dollars) - Math.abs(a.balance_dollars))
        .slice(0, 3);

      if (largestLiabilities.length > 0) {
        insights.push(`Your largest liabilities: ${largestLiabilities.map(acc => `${acc.name} (${formatCurrency(acc.balance_dollars)})`).join(', ')}`);
      }

      // Add asset allocation insights
      const realEstateAssets = assets.filter(acc => acc.name.toLowerCase().includes('house') || acc.name.toLowerCase().includes('home'));
      const investmentAssets = assets.filter(acc => acc.type === 'otherAsset' && !realEstateAssets.includes(acc));
      const liquidAssets = assets.filter(acc => ['checking', 'savings', 'cash'].includes(acc.type));

      if (realEstateAssets.length > 0) {
        const realEstateValue = realEstateAssets.reduce((sum, acc) => sum + acc.balance_dollars, 0);
        const totalAssetsInDollars = milliUnitsToAmount(totalAssets);
        const realEstatePercentage = (realEstateValue / totalAssetsInDollars) * 100;
        insights.push(`Real estate represents ${realEstatePercentage.toFixed(1)}% of your total assets (${formatCurrency(realEstateValue)})`);
      }

      if (investmentAssets.length > 0) {
        const investmentValue = investmentAssets.reduce((sum, acc) => sum + acc.balance_dollars, 0);
        const totalAssetsInDollars = milliUnitsToAmount(totalAssets);
        const investmentPercentage = (investmentValue / totalAssetsInDollars) * 100;
        insights.push(`Investments represent ${investmentPercentage.toFixed(1)}% of your total assets (${formatCurrency(investmentValue)})`);
      }

      if (liquidAssets.length > 0) {
        const liquidValue = liquidAssets.reduce((sum, acc) => sum + acc.balance_dollars, 0);
        insights.push(`You have ${formatCurrency(liquidValue)} in liquid assets (checking, savings, cash)`);
      }

      const result: NetWorthAnalysisResult = {
        current_net_worth: milliUnitsToAmount(netWorth),
        total_assets: milliUnitsToAmount(totalAssets),
        total_liabilities: milliUnitsToAmount(totalLiabilities),
        account_breakdown: {
          assets: assets,
          liabilities: liabilities
        },
        insights: insights,
        note: "This analysis shows current account balances only. Historical net worth trends are not available due to YNAB API limitations. To track net worth changes over time, consider manually recording your net worth monthly or using a separate tracking tool."
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
    } catch (error: unknown) {
      console.error(`Error analyzing net worth:`);
      console.error(JSON.stringify(error, null, 2));
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error analyzing net worth: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
          },
        ],
      };
    }
  }

  private formatMarkdown(result: NetWorthAnalysisResult): string {
    let output = "# Net Worth Analysis\n\n";

    output += "## Summary\n";
    output += `- **Current Net Worth**: ${formatCurrency(result.current_net_worth)}\n`;
    output += `- **Total Assets**: ${formatCurrency(result.total_assets)}\n`;
    output += `- **Total Liabilities**: ${formatCurrency(result.total_liabilities)}\n\n`;

    if (result.account_breakdown.assets.length > 0) {
      output += "## Assets\n\n";
      for (const asset of result.account_breakdown.assets) {
        output += `- **${asset.name}** (${asset.type})\n`;
        output += `  - Balance: ${formatCurrency(asset.balance_dollars)}\n`;
        output += `  - On Budget: ${asset.on_budget ? 'Yes' : 'No'}\n`;
      }
      output += "\n";
    }

    if (result.account_breakdown.liabilities.length > 0) {
      output += "## Liabilities\n\n";
      for (const liability of result.account_breakdown.liabilities) {
        output += `- **${liability.name}** (${liability.type})\n`;
        output += `  - Balance: ${formatCurrency(liability.balance_dollars)}\n`;
        output += `  - On Budget: ${liability.on_budget ? 'Yes' : 'No'}\n`;
      }
      output += "\n";
    }

    if (result.insights.length > 0) {
      output += "## Insights\n\n";
      for (const insight of result.insights) {
        output += `- ${insight}\n`;
      }
      output += "\n";
    }

    output += `## Note\n${result.note}\n`;

    return output;
  }
}

export default NetWorthAnalysisTool;
