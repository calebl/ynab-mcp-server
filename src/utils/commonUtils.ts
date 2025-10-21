/**
 * Common utility functions used across YNAB MCP tools
 */

/**
 * Convert a month string to ISO format
 * @param month - Either "current" or a date string in YYYY-MM-DD format
 * @returns ISO formatted date string (YYYY-MM-DD)
 */
export function normalizeMonth(month: string | undefined): string {
  if (!month || month === "current") {
    return new Date().toISOString().slice(0, 7) + "-01";
  }
  return month;
}

/**
 * Convert YNAB milliUnits to standard currency amount
 * @param milliUnits - Amount in YNAB milliUnits format
 * @returns Amount in standard currency format (dollars, euros, etc.)
 */
export function milliUnitsToAmount(milliUnits: number): number {
  return milliUnits / 1000;
}

/**
 * Convert standard currency amount to YNAB milliUnits
 * @param amount - Amount in standard currency format
 * @returns Amount in YNAB milliUnits format
 */
export function amountToMilliUnits(amount: number): number {
  return Math.round(amount * 1000);
}

/**
 * Get budget ID from input or environment variable
 * @param budgetId - Optional budget ID from tool input
 * @returns Budget ID string
 * @throws Error if no budget ID is available
 */
export function getBudgetId(budgetId?: string): string {
  const id = budgetId || process.env.YNAB_BUDGET_ID;
  if (!id) {
    throw new Error(
      "Budget ID is required. Either provide budgetId parameter or set YNAB_BUDGET_ID environment variable. Use the list_budgets tool to find your budget ID."
    );
  }
  return id;
}

/**
 * Format a date string to human-readable format
 * @param dateString - ISO date string
 * @returns Human-readable date string
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format currency amount for display
 * @param amount - Amount in standard currency format
 * @param currency - Currency symbol (default: $)
 * @returns Formatted currency string
 */
export function formatCurrency(amount: number, currency: string = "$"): string {
  return `${currency}${amount.toFixed(2)}`;
}

/**
 * Truncate response text to fit within character limit
 * @param text - Text to truncate
 * @param limit - Character limit (default: 25000)
 * @returns Truncated text with message if truncation occurred
 */
export function truncateResponse(text: string, limit: number = 25000): {
  text: string;
  wasTruncated: boolean;
} {
  if (text.length <= limit) {
    return { text, wasTruncated: false };
  }

  const truncated = text.slice(0, limit - 200); // Reserve space for message
  const truncationMessage = `\n\n[Response truncated from ${text.length} to ${truncated.length} characters. Use pagination or filtering parameters to see more results.]`;

  return {
    text: truncated + truncationMessage,
    wasTruncated: true,
  };
}

/**
 * Character limit constant for MCP responses
 */
export const CHARACTER_LIMIT = 25000;
