import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ListPayeeLocationsTool from '../tools/ListPayeeLocationsTool';

describe('ListPayeeLocationsTool', () => {
  let mockApi: { payeeLocations: { getPayeeLocations: Mock; getPayeeLocationsByPayee: Mock } };

  const locations = [
    { id: 'loc-1', payee_id: 'payee-1', latitude: '40.7', longitude: '-74.0', deleted: false },
    { id: 'loc-2', payee_id: 'payee-1', latitude: '40.8', longitude: '-74.1', deleted: false },
    { id: 'loc-3', payee_id: 'payee-1', latitude: '40.9', longitude: '-74.2', deleted: true },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    const response = { data: { payee_locations: locations } };
    mockApi = {
      payeeLocations: {
        getPayeeLocations: vi.fn().mockResolvedValue(response),
        getPayeeLocationsByPayee: vi.fn().mockResolvedValue(response),
      },
    };
    delete process.env.YNAB_PLAN_ID;
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('lists only the given payee\'s locations when payeeId is passed', async () => {
    await ListPayeeLocationsTool.execute({ payeeId: 'payee-1' }, mockApi as any);

    expect(mockApi.payeeLocations.getPayeeLocationsByPayee).toHaveBeenCalledWith('test-budget-id', 'payee-1');
    expect(mockApi.payeeLocations.getPayeeLocations).not.toHaveBeenCalled();
  });

  it('lists every location when payeeId is omitted', async () => {
    await ListPayeeLocationsTool.execute({}, mockApi as any);

    expect(mockApi.payeeLocations.getPayeeLocations).toHaveBeenCalledWith('test-budget-id');
    expect(mockApi.payeeLocations.getPayeeLocationsByPayee).not.toHaveBeenCalled();
  });

  it('omits deleted locations and counts the rest', async () => {
    const result = await ListPayeeLocationsTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.payee_locations.map((l: { id: string }) => l.id)).toEqual(['loc-1', 'loc-2']);
    expect(response.payee_location_count).toBe(2);
    for (const location of response.payee_locations) {
      expect(location).not.toHaveProperty('deleted');
    }
  });

  it('returns success false with the error message when the API rejects', async () => {
    mockApi.payeeLocations.getPayeeLocations.mockRejectedValue(new Error('API Error'));

    const result = await ListPayeeLocationsTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
  });
});
