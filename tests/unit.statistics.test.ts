import { describe, expect, it } from "vitest";
import {
  buildStatisticsSummary,
  computeBookTrajectory,
  computeHourlyDistribution,
  computeReadingStreaks,
  parseStatisticsSummary,
  MAX_FUTURE_SKEW_SECONDS,
  STATISTICS_SUMMARY_VERSION,
  type StatisticsSummary,
} from "../src/services/statistics";
import type { StatisticsSnapshot } from "../src/types";

function snapshotWithPageStats(books: Array<{ md5: string; page_stat_data: Array<{ start_time: number; duration: number }> }>): StatisticsSnapshot {
  return {
    books: books.map((b) => ({
      md5: b.md5,
      title: "T",
      authors: "",
      notes: 0,
      last_open: 0,
      highlights: 0,
      pages: 1,
      series: "",
      language: "",
      total_read_time: 0,
      total_read_pages: 0,
      page_stat_data: b.page_stat_data.map((s, i) => ({ page: i + 1, start_time: s.start_time, duration: s.duration, total_pages: 1 })),
    })),
  };
}

describe("buildStatisticsSummary", () => {
  it("aggregates daily and per-book per-day per-hour minutes with rounding", () => {
    const base = new Date(2024, 0, 5, 10, 30, 0);
    const t1 = Math.floor(base.getTime() / 1000);
    const t2 = t1 + 3600;

    const snapshot = snapshotWithPageStats([
      {
        md5: "abc",
        page_stat_data: [
          { start_time: t1, duration: 61 },
          { start_time: t1 + 90, duration: 59 },
          { start_time: t2, duration: 120 },
        ],
      },
      {
        md5: "def",
        page_stat_data: [{ start_time: t2, duration: 30 }],
      },
    ]);

    const summary = buildStatisticsSummary(snapshot);

    // 61 -> 1, 59 -> 1, 120 -> 2, 30 -> 1
    expect(summary.daily["2024-01-05"]).toBe(5);

    expect(summary.books.abc.days["2024-01-05"]["10"]).toBe(2);
    expect(summary.books.abc.days["2024-01-05"]["11"]).toBe(2);
    expect(summary.books.def.days["2024-01-05"]["11"]).toBe(1);
  });

  it("ignores invalid page stat entries", () => {
    const base = new Date(2024, 0, 5, 10, 30, 0);
    const t1 = Math.floor(base.getTime() / 1000);

    const snapshot = snapshotWithPageStats([
      {
        md5: "abc",
        page_stat_data: [
          { start_time: NaN, duration: 10 },
          { start_time: t1, duration: 0 },
          { start_time: t1, duration: -5 },
        ],
      },
    ]);

    const summary = buildStatisticsSummary(snapshot);
    expect(Object.keys(summary.daily)).toHaveLength(0);
    expect(Object.keys(summary.books.abc.days)).toHaveLength(0);
  });

  it("excludes reading entries whose start time is implausibly in the future", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const withinSkew = nowSeconds + 60 * 60; // 1 hour ahead: tolerated device drift
    const beyondSkew = nowSeconds + 48 * 60 * 60; // 2 days ahead: a bad device clock

    const snapshot = snapshotWithPageStats([
      {
        md5: "abc",
        page_stat_data: [
          { start_time: nowSeconds - 3600, duration: 120 },
          { start_time: withinSkew, duration: 60 },
          { start_time: beyondSkew, duration: 600 },
        ],
      },
    ]);

    const summary = buildStatisticsSummary(snapshot);
    const total = Object.values(summary.daily).reduce((sum, mins) => sum + mins, 0);
    // Only the past entry (2 min) and the tolerated near-future entry (1 min) survive.
    expect(total).toBe(3);
    const futureKey = new Date(beyondSkew * 1000);
    const futureDateKey =
      futureKey.getFullYear() + '-' + String(futureKey.getMonth() + 1).padStart(2, '0') + '-' + String(futureKey.getDate()).padStart(2, '0');
    expect(summary.daily[futureDateKey]).toBeUndefined();
    expect(summary.books.abc.days[futureDateKey]).toBeUndefined();
  });

  it("keeps entries exactly at the skew boundary and drops those past it", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    // Pin the boundary to the documented constant rather than a magic offset.
    const atBoundary = Math.floor((Date.now() + MAX_FUTURE_SKEW_SECONDS * 1000) / 1000) - 1;
    const pastBoundary = Math.floor((Date.now() + MAX_FUTURE_SKEW_SECONDS * 1000) / 1000) + 60;

    const snapshot = snapshotWithPageStats([
      {
        md5: "abc",
        page_stat_data: [
          { start_time: atBoundary, duration: 60 },
          { start_time: pastBoundary, duration: 600 },
        ],
      },
    ]);

    const summary = buildStatisticsSummary(snapshot);
    const total = Object.values(summary.daily).reduce((sum, mins) => sum + mins, 0);
    // Only the boundary entry (1 min) is retained.
    expect(total).toBe(1);
  });

  it("carries book metadata into the summary", () => {
    const snapshot: StatisticsSnapshot = {
      books: [
        {
          md5: "abc",
          title: "Book A",
          authors: "X",
          notes: 3,
          last_open: 42,
          highlights: 7,
          pages: 300,
          series: "S1",
          language: "en",
          total_read_time: 120,
          total_read_pages: 60,
          page_stat_data: [],
        },
      ],
    };
    const summary = buildStatisticsSummary(snapshot);
    expect(summary.books.abc).toMatchObject({
      md5: "abc",
      title: "Book A",
      authors: "X",
      notes: 3,
      last_open: 42,
      highlights: 7,
      pages: 300,
      series: "S1",
      language: "en",
      total_read_time: 120,
      total_read_pages: 60,
    });
  });
});

describe("parseStatisticsSummary", () => {
  it("round-trips through JSON and rejects invalid input", () => {
    const snapshot = snapshotWithPageStats([]);
    const summary = buildStatisticsSummary(snapshot);

    expect(parseStatisticsSummary(JSON.stringify(summary))).toEqual(summary);
    expect(parseStatisticsSummary(null)).toBeNull();
    expect(parseStatisticsSummary(undefined)).toBeNull();
    expect(parseStatisticsSummary("")).toBeNull();
    expect(parseStatisticsSummary("{bad json")).toBeNull();
    expect(parseStatisticsSummary(JSON.stringify({ version: 1, daily: {}, books: {} }))).toBeNull();
    expect(parseStatisticsSummary(JSON.stringify({ version: 999, daily: {}, books: {} }))).toBeNull();
    expect(parseStatisticsSummary(JSON.stringify({ version: STATISTICS_SUMMARY_VERSION, daily: {}, books: {} }))).not.toBeNull();
  });
});

describe("computeReadingStreaks", () => {
  it("calculates activeDays, currentStreak and longestStreak correctly", () => {
    // Empty dates
    expect(computeReadingStreaks([])).toEqual({
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
    });

    // Reference today: 2026-03-30
    const today = new Date("2026-03-30T12:00:00Z");

    // Case 1: active today and yesterday -> streak 2
    expect(computeReadingStreaks(["2026-03-29", "2026-03-30"], today)).toEqual({
      activeDays: 2,
      currentStreak: 2,
      longestStreak: 2,
    });

    // Case 2: active yesterday but not today -> streak continues up to yesterday (streak 1)
    expect(computeReadingStreaks(["2026-03-29"], today)).toEqual({
      activeDays: 1,
      currentStreak: 1,
      longestStreak: 1,
    });

    // Case 3: active 2 days ago but neither today nor yesterday -> current streak 0
    expect(computeReadingStreaks(["2026-03-28"], today)).toEqual({
      activeDays: 1,
      currentStreak: 0,
      longestStreak: 1,
    });

    // Case 4: longest streak is historical, current streak is shorter
    // Dates: 2026-01-01 to 2026-01-04 (streak 4), then 2026-03-29 to 2026-03-30 (streak 2)
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04", "2026-03-29", "2026-03-30"];
    expect(computeReadingStreaks(dates, today)).toEqual({
      activeDays: 6,
      currentStreak: 2,
      longestStreak: 4,
    });
  });
});

describe("computeHourlyDistribution", () => {
  it("aggregates reading duration by 24 hours across books", () => {
    const summary: StatisticsSummary = {
      version: STATISTICS_SUMMARY_VERSION,
      daily: {
        "2026-03-29": { total_time: 15, total_pages: 5, books_count: 1 },
        "2026-03-30": { total_time: 30, total_pages: 10, books_count: 2 },
      },
      books: {
        b1: {
          md5: "b1",
          title: "Book 1",
          authors: "Author",
          notes: 0,
          last_open: 100,
          highlights: 0,
          pages: 100,
          series: null,
          language: null,
          total_read_time: 30,
          total_read_pages: 10,
          days: {
            "2026-03-29": { 8: 15 },
            "2026-03-30": { 8: 5, 22: 10 },
          },
        },
        b2: {
          md5: "b2",
          title: "Book 2",
          authors: "Author",
          notes: 0,
          last_open: 100,
          highlights: 0,
          pages: 100,
          series: null,
          language: null,
          total_read_time: 15,
          total_read_pages: 5,
          days: {
            "2026-03-30": { 22: 15 },
          },
        },
      },
    };

    const dist = computeHourlyDistribution(summary);
    expect(dist).toHaveLength(24);
    expect(dist[8]).toBe(20); // 15 + 5
    expect(dist[22]).toBe(25); // 10 + 15
    expect(dist[0]).toBe(0);
    expect(dist[12]).toBe(0);
  });

  it("applies positive and negative timezone offsets correctly", () => {
    const summary: StatisticsSummary = {
      version: STATISTICS_SUMMARY_VERSION,
      daily: {},
      books: {
        b1: {
          md5: "b1",
          title: "Book 1",
          authors: "Author",
          notes: 0,
          last_open: 100,
          highlights: 0,
          pages: 100,
          series: null,
          language: null,
          total_read_time: 30,
          total_read_pages: 10,
          days: {
            "2026-03-30": { 14: 30, 22: 15 },
          },
        },
      },
    };

    // +8 hours: 14 -> 22, 22 -> (22+8)%24 = 6
    const distPlus8 = computeHourlyDistribution(summary, 8);
    expect(distPlus8[22]).toBe(30);
    expect(distPlus8[6]).toBe(15);
    expect(distPlus8[14]).toBe(0);

    // -5 hours: 14 -> 9, 22 -> 17
    const distMinus5 = computeHourlyDistribution(summary, -5);
    expect(distMinus5[9]).toBe(30);
    expect(distMinus5[17]).toBe(15);
  });
});

describe("computeBookTrajectory", () => {
  it("computes trajectory breakdown, speed metrics and sorted recent sessions", () => {
    const trajectory = computeBookTrajectory({
      md5: "test-md5",
      title: "Test Book",
      authors: "Test Author",
      series: "Test Series",
      language: "en",
      notes: 3,
      highlights: 5,
      pages: 200,
      total_read_pages: 50,
      total_read_time: 3600,
      last_open: 1711800000,
      page_stat_data: [
        { page: 10, start_time: 1711756800, duration: 600, total_pages: 200 },
        { page: 12, start_time: 1711757400, duration: 600, total_pages: 200 },
        { page: 25, start_time: 1711843200, duration: 1200, total_pages: 200 },
      ],
    });

    expect(trajectory.md5).toBe("test-md5");
    expect(trajectory.title).toBe("Test Book");
    expect(trajectory.total_read_pages).toBe(50);
    expect(trajectory.total_read_time).toBe(3600);
    expect(trajectory.reading_speed.seconds_per_page).toBe(72);
    expect(trajectory.reading_speed.pages_per_hour).toBe(50);
    expect(trajectory.daily_history.length).toBe(2);
    expect(trajectory.recent_sessions.length).toBe(3);
    // Recent sessions sorted desc
    expect(trajectory.recent_sessions[0].start_time).toBe(1711843200);
    expect(trajectory.recent_sessions[1].start_time).toBe(1711757400);
    expect(trajectory.recent_sessions[2].start_time).toBe(1711756800);
    // Aliases present
    expect(trajectory.dailyHistory).toBe(trajectory.daily_history);
    expect(trajectory.recentSessions).toBe(trajectory.recent_sessions);
    expect(trajectory.readingSpeed).toBe(trajectory.reading_speed);
  });

  it("drops future-dated sessions from the trajectory", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const future = nowSeconds + 30 * 24 * 60 * 60;
    const trajectory = computeBookTrajectory({
      md5: "future-md5",
      title: "Future Book",
      authors: "",
      series: "",
      language: "en",
      notes: 0,
      highlights: 0,
      pages: 100,
      total_read_pages: 1,
      total_read_time: 60,
      last_open: future,
      page_stat_data: [
        { page: 1, start_time: nowSeconds - 3600, duration: 600, total_pages: 100 },
        { page: 2, start_time: future, duration: 600, total_pages: 100 },
      ],
    });

    expect(trajectory.recent_sessions).toHaveLength(1);
    expect(trajectory.recent_sessions[0].start_time).toBe(nowSeconds - 3600);
    expect(trajectory.daily_history).toHaveLength(1);
  });

  it("handles empty or missing page_stat_data gracefully", () => {
    const trajectory = computeBookTrajectory({
      md5: "empty-md5",
      title: "Empty Book",
      authors: "None",
      series: null,
      language: null,
      notes: 0,
      highlights: 0,
      pages: 100,
      total_read_pages: 0,
      total_read_time: 0,
      last_open: null,
    });

    expect(trajectory.daily_history).toEqual([]);
    expect(trajectory.recent_sessions).toEqual([]);
    expect(trajectory.reading_speed.seconds_per_page).toBeNull();
    expect(trajectory.reading_speed.pages_per_hour).toBeNull();
  });
});
