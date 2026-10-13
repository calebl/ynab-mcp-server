import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as GetPayeeLocationTool from '../tools/GetPayeeLocationTool';

describe('GetPayeeLocationTool', () => {
  let mockApi: { payeeLocations: { getPayeeLocationById: Mock } };

  const location = { id: 'loc-1', payee_id: 'payee-1', latitude: '40.7', longitude: '-74.0', deleted: false };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      payeeLocations: {
        getPayeeLocationById: vi.fn().mockResolvedValue({ data: { payee_location: location } }),
      },
    };
    delete process.env.YNAB_PLAN_ID;
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('returns the location with latitude and longitude strings unchanged', async () => {
    const result = await GetPayeeLocationTool.execute({ payeeLocationId: 'loc-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(mockApi.payeeLocations.getPayeeLocationById).toHaveBeenCalledWith('test-budget-id', 'loc-1');
    expect(response.payee_location).toEqual(location);
    expect(response.payee_location.latitude).toBe('40.7');
  });

  it('returns success false with the error message when the API rejects', async () => {
    mockApi.payeeLocations.getPayeeLocationById.mockRejectedValue(new Error('Not found'));

    const result = await GetPayeeLocationTool.execute({ payeeLocationId: 'loc-1' }, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('Not found');
  });
});
