/**
 * Extracts a meaningful error message from various error types,
 * including YNAB API error responses.
 */
export function toolError(error: string) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: false, error }, null, 2),
    }],
    isError: true,
  };
}

export function getErrorMessage(error: unknown): string {
  // Handle standard Error objects
  if (error instanceof Error) {
    return error.message;
  }

  // Handle YNAB API error responses which have the structure:
  // { error: { id: '...', name: '...', detail: '...' } }
  if (
    typeof error === 'object' &&
    error !== null &&
    'error' in error &&
    typeof (error as any).error === 'object'
  ) {
    const ynabError = (error as any).error;
    if (ynabError.detail) {
      return ynabError.detail;
    }
    if (ynabError.name) {
      return ynabError.name;
    }
  }

  // Fallback: try to stringify the error
  try {
    const stringified = JSON.stringify(error);
    if (stringified !== '{}') {
      return stringified;
    }
  } catch {
    // Ignore stringify errors
  }

  return 'Unknown error occurred';
}
