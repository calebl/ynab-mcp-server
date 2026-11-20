import { z } from 'zod';
import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import * as ynab from 'ynab';
import * as GoalSummaryTool from '../tools/GoalSummaryTool';

vi.mock('ynab');

const category = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id,
  category_group_id: 'group-1',
  category_group_name: 'Group',
  hidden: false,
  deleted: false,
  budgeted: 0,
  activity: 0,
  balance: 0,
  ...overrides,
});

const mockMonth = {
  data: {
    month: {
      month: '2026-11-01',
      categories: [
        category('rent', { goal_type: 'NEED', goal_target: 1000000, goal_percentage_complete: 50, goal_under_funded: 500000, goal_target_date: '2026-12-01' }),
        category('trip', { goal_type: 'TBD', goal_target: 300000, goal_percentage_complete: 100, goal_under_funded: 0 }),
        category('car', { goal_type: 'NEED', goal_target: 200500, goal_percentage_complete: null, goal_under_funded: 200500 }),
        category('gym', { goal_type: 'MF', goal_target: 0, goal_percentage_complete: 0, goal_under_funded: 500000 }),
        category('old-hidden', { hidden: true, goal_type: 'TB', goal_target: 100000, goal_percentage_complete: 10, goal_under_funded: 900000 }),
        category('old-deleted', { deleted: true, goal_type: 'TB', goal_target: 100000, goal_under_funded: 100000 }),
        category('overfunded', { goal_type: 'NEED', goal_target: 0, goal_percentage_complete: null, goal_under_funded: -1000 }),
        category('no-goal'),
      ],
    },
  },
};

describe('GoalSummaryTool', () => {
  let mockApi: { months: { getPlanMonth: Mock }; plans: { getPlanSettingsById: Mock } };

  const run = async (input: Record<string, unknown> = {}) => {
    const result = await GoalSummaryTool.execute(input as any, mockApi as any);
    return JSON.parse(result.content[0].text);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = {
      months: { getPlanMonth: vi.fn().mockResolvedValue(mockMonth) },
      plans: { getPlanSettingsById: vi.fn().mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 2 } } } }) },
    };
    (ynab.API as any).mockImplementation(() => mockApi);
    process.env.YNAB_API_TOKEN = 'test-token';
    process.env.YNAB_BUDGET_ID = 'test-budget-id';
  });

  it('computes totals, excluding null percentages from the average', async () => {
    const r = await run();
    expect(r.goal_count).toBe(5);
    expect(r.total_target).toBe(1500.5);
    expect(r.total_under_funded).toBe(1200.5);
    expect(r.average_percentage_complete).toBe(50); // (50 + 100 + 0) / 3
  });

  it('groups by goal type', async () => {
    const r = await run();
    expect(r.by_goal_type).toEqual({
      NEED: { count: 3, under_funded: 700.5 },
      TBD: { count: 1, under_funded: 0 },
      MF: { count: 1, under_funded: 500 },
    });
  });

  it('lists under-funded categories largest first, ties by name, with the listed fields', async () => {
    const r = await run();
    expect(r.underfunded.map((c: any) => c.id)).toEqual(['gym', 'rent', 'car']);
    expect(r.underfunded[1]).toEqual({
      id: 'rent',
      name: 'rent',
      category_group_name: 'Group',
      goal_type: 'NEED',
      goal_target: 1000,
      goal_target_date: '2026-12-01',
      goal_percentage_complete: 50,
      goal_under_funded: 500,
    });
    expect(r.underfunded[0].goal_target).toBeNull();
  });

  it('skips deleted, hidden and goal-less categories, and includes hidden on request', async () => {
    const r = await run();
    expect(r.skipped_count).toBe(3);
    expect(r.underfunded.map((c: any) => c.id)).not.toContain('overfunded');

    const all = await run({ includeHidden: true });
    expect(all.goal_count).toBe(6);
    expect(all.skipped_count).toBe(2);
    expect(all.underfunded[0].id).toBe('old-hidden');
  });

  it('returns a null average when no included category has a percentage', async () => {
    mockApi.months.getPlanMonth.mockResolvedValue({
      data: { month: { month: '2026-11-01', categories: [category('a', { goal_type: 'TB', goal_percentage_complete: null })] } },
    });
    const r = await run();
    expect(r.average_percentage_complete).toBeNull();
    expect(r.goal_count).toBe(1);
    expect(r.underfunded).toEqual([]);
  });

  it('calls getPlanMonth once, defaults month to current, and reports the resolved month', async () => {
    const r = await run();
    expect(mockApi.months.getPlanMonth).toHaveBeenCalledTimes(1);
    expect(mockApi.months.getPlanMonth).toHaveBeenCalledWith('test-budget-id', 'current');
    expect(r.month).toBe('2026-11-01');

    await run({ month: '2026-10-01' });
    expect(mockApi.months.getPlanMonth).toHaveBeenLastCalledWith('test-budget-id', '2026-10-01');
  });

  it('reads the plan decimal digits once and uses them for amounts', async () => {
    await run();
    expect(mockApi.plans.getPlanSettingsById).toHaveBeenCalledTimes(1);
    expect(mockApi.plans.getPlanSettingsById).toHaveBeenCalledWith('test-budget-id');

    mockApi.plans.getPlanSettingsById.mockResolvedValue({ data: { settings: { currency_format: { decimal_digits: 0 } } } });
    mockApi.months.getPlanMonth.mockResolvedValue({
      data: { month: { month: '2026-11-01', categories: [category('a', { goal_type: 'TB', goal_target: 1500, goal_under_funded: 1500 })] } },
    });
    const fresh = { ...mockApi, plans: { getPlanSettingsById: mockApi.plans.getPlanSettingsById } };
    const result = await GoalSummaryTool.execute({}, fresh as any);
    expect(JSON.parse(result.content[0].text).total_target).toBe(2);
  });

  it('validates month and defaults the inputs', () => {
    const schema = z.object(GoalSummaryTool.inputSchema);
    expect(schema.safeParse({ month: '2026-11' }).success).toBe(false);
    expect(schema.safeParse({ month: 'last' }).success).toBe(false);
    expect(schema.safeParse({ month: 'current' }).success).toBe(true);
    expect(schema.safeParse({ month: '2026-11-01' }).success).toBe(true);
    expect(schema.parse({})).toMatchObject({ month: 'current', includeHidden: false });
  });

  it('returns an error result when the API fails', async () => {
    mockApi.months.getPlanMonth.mockRejectedValue(new Error('API Error'));
    const result = await GoalSummaryTool.execute({}, mockApi as any);
    const r = JSON.parse(result.content[0].text);
    expect(r.success).toBe(false);
    expect(r.error).toBe('API Error');
    expect(result.isError).toBe(true);
  });
});
