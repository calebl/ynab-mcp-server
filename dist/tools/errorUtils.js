/**
 * Extracts a meaningful error message from various error types,
 * including YNAB API error responses.
 */
export function getErrorMessage(error) {
    // Handle standard Error objects
    if (error instanceof Error) {
        return error.message;
    }
    // Handle YNAB API error responses which have the structure:
    // { error: { id: '...', name: '...', detail: '...' } }
    if (typeof error === 'object' &&
        error !== null &&
        'error' in error &&
        typeof error.error === 'object') {
        const ynabError = error.error;
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
    }
    catch {
        // Ignore stringify errors
    }
    return 'Unknown error occurred';
}
