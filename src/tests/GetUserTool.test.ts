import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetUserTool from '../tools/GetUserTool';

vi.mock('ynab');

describe('GetUserTool', () => {
  let mockApi: { user: { getUser: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { user: { getUser: vi.fn() } };
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
  });

  it('returns the authenticated user ID', async () => {
    mockApi.user.getUser.mockResolvedValue({ data: { user: { id: 'user-123' } } });

    const result = await GetUserTool.execute({}, mockApi as any);

    expect(mockApi.user.getUser).toHaveBeenCalledWith();
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'user-123' });
  });

  it('takes no input', () => {
    expect(Object.keys(GetUserTool.inputSchema)).toHaveLength(0);
  });

  it('returns an error result when the API fails', async () => {
    mockApi.user.getUser.mockRejectedValue(new Error('API Error'));

    const result = await GetUserTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });

  it('has the ynab_get_user name', () => {
    expect(GetUserTool.name).toBe('ynab_get_user');
  });
});
