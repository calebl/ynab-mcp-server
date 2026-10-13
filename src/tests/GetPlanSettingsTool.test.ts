import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GetPlanSettingsTool from '../tools/GetPlanSettingsTool';

vi.mock('ynab');

const dateFormat = { format: 'MM/DD/YYYY' };
const currencyFormat = {
  iso_code: 'USD',
  example_format: '123,456.78',
  decimal_digits: 2,
  decimal_separator: '.',
  symbol_first: true,
  group_separator: ',',
  currency_symbol: '$',
  display_symbol: true,
};

describe('GetPlanSettingsTool', () => {
  let mockApi: { plans: { getPlanSettingsById: Mock } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { plans: { getPlanSettingsById: vi.fn() } };
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('returns the date and currency formats as YNAB reports them', async () => {
    mockApi.plans.getPlanSettingsById.mockResolvedValue({
      data: { settings: { date_format: dateFormat, currency_format: currencyFormat } },
    });

    const result = await GetPlanSettingsTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(mockApi.plans.getPlanSettingsById).toHaveBeenCalledWith('test-budget-id');
    expect(response.date_format).toEqual(dateFormat);
    expect(response.currency_format).toEqual(currencyFormat);
  });

  it('returns an error result when the API fails', async () => {
    mockApi.plans.getPlanSettingsById.mockRejectedValue(new Error('API Error'));

    const result = await GetPlanSettingsTool.execute({}, mockApi as any);
    const response = JSON.parse(result.content[0].text);

    expect(response.success).toBe(false);
    expect(response.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });

  it('returns an error when no plan ID is available', async () => {
    delete process.env.YNAB_PLAN_ID;
    delete process.env.YNAB_BUDGET_ID;

    const result = await GetPlanSettingsTool.execute({}, mockApi as any);

    expect(JSON.parse(result.content[0].text).error).toContain('No plan ID provided');
  });

  it('has the ynab_get_plan_settings name', () => {
    expect(GetPlanSettingsTool.name).toBe('ynab_get_plan_settings');
  });
});
