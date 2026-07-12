import { describe, expect, it } from "vitest";
import {
  MAX_SITE_ALERT_RECIPIENTS,
  getSiteAlerts,
  saveSiteAlerts,
  sendTestSiteAlert,
} from "./alerts.js";
import { createSupabaseMock } from "./test-utils.js";

const statusResult = {
  configured: false,
  setting: {
    site_id: 12,
    enabled: false,
    uptime_enabled: true,
    uptime_threshold_minutes: 10,
    performance_enabled: true,
    performance_threshold: 70,
    seo_critical_enabled: true,
    notify_on_recovery: true,
    recipients: [],
  },
  conditions: {},
  incidents: [],
  events: [],
  future_field: { supported: true },
};

describe("getSiteAlerts", () => {
  it("uses the numeric site-alerts status contract and preserves unknown fields", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, statusResult);

    const result = await getSiteAlerts(supabase, "12");

    expect(result).toEqual(statusResult);
    expect(result.future_field).toEqual({ supported: true });
    expect(functionCalls).toEqual([
      {
        name: "site-alerts",
        body: { action: "status", site_id: 12 },
      },
    ]);
  });

  it.each([0, -1, 1.5, "site-1", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid Lagos site IDs (%s) before invoking the function",
    async (siteId) => {
      const { supabase, functionCalls } = createSupabaseMock({});

      await expect(getSiteAlerts(supabase, siteId)).rejects.toThrow(
        "siteId must be an integer between 1",
      );
      expect(functionCalls).toEqual([]);
    },
  );
});

describe("saveSiteAlerts", () => {
  it("normalizes recipients and sends a complete snake_case payload with Lagos defaults", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, {
      setting: statusResult.setting,
      evaluation: null,
      incidents: [],
      events: [],
    });

    await saveSiteAlerts(supabase, 12, {
      enabled: true,
      recipients: [" OWNER@Example.test ", "owner@example.test"],
    });

    expect(functionCalls).toEqual([
      {
        name: "site-alerts",
        body: {
          action: "save",
          site_id: 12,
          enabled: true,
          uptime_enabled: true,
          uptime_threshold_minutes: 10,
          performance_enabled: true,
          performance_threshold: 70,
          seo_critical_enabled: true,
          notify_on_recovery: true,
          recipients: ["owner@example.test"],
        },
      },
    ]);
  });

  it("maps every custom option to the exact setting fields", async () => {
    const { supabase, functionCalls } = createSupabaseMock({}, {
      setting: statusResult.setting,
      evaluation: null,
      incidents: [],
      events: [],
    });

    await saveSiteAlerts(supabase, "12", {
      enabled: false,
      recipients: [],
      uptimeEnabled: false,
      uptimeThresholdMinutes: 1440,
      performanceEnabled: false,
      performanceThreshold: 1,
      seoCriticalEnabled: false,
      notifyOnRecovery: false,
    });

    expect(functionCalls[0]).toEqual({
      name: "site-alerts",
      body: {
        action: "save",
        site_id: 12,
        enabled: false,
        uptime_enabled: false,
        uptime_threshold_minutes: 1440,
        performance_enabled: false,
        performance_threshold: 1,
        seo_critical_enabled: false,
        notify_on_recovery: false,
        recipients: [],
      },
    });
  });

  it("requires recipients and at least one active rule when enabled", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(saveSiteAlerts(supabase, 12, { enabled: true })).rejects.toThrow(
      "At least one alert recipient",
    );
    await expect(saveSiteAlerts(supabase, 12, {
      enabled: true,
      recipients: ["owner@example.test"],
      uptimeEnabled: false,
      performanceEnabled: false,
      seoCriticalEnabled: false,
    })).rejects.toThrow("Enable at least one alert rule");
    expect(functionCalls).toEqual([]);
  });

  it("enforces both threshold ranges even when alerts are paused", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(saveSiteAlerts(supabase, 12, {
      enabled: false,
      uptimeThresholdMinutes: 4,
    })).rejects.toThrow("uptime threshold must be an integer between 5 and 1440");
    await expect(saveSiteAlerts(supabase, 12, {
      enabled: false,
      performanceThreshold: 101,
    })).rejects.toThrow("performance threshold must be an integer between 1 and 100");
    expect(functionCalls).toEqual([]);
  });
});

describe("sendTestSiteAlert", () => {
  it("normalizes and deduplicates recipients in the send_test payload", async () => {
    const event = { id: "event-1", delivery_status: "sent", future_field: 1 };
    const { supabase, functionCalls } = createSupabaseMock({}, { event });

    const result = await sendTestSiteAlert(supabase, "12", [
      " Alert@Example.test ",
      "alert@example.test",
      "second@example.test",
    ]);

    expect(result.event).toEqual(event);
    expect(functionCalls).toEqual([
      {
        name: "site-alerts",
        body: {
          action: "send_test",
          site_id: 12,
          recipients: ["alert@example.test", "second@example.test"],
        },
      },
    ]);
  });

  it("requires valid recipients and enforces the Lagos maximum", async () => {
    const { supabase, functionCalls } = createSupabaseMock({});

    await expect(sendTestSiteAlert(supabase, 12, [])).rejects.toThrow(
      "At least one alert recipient",
    );
    await expect(sendTestSiteAlert(supabase, 12, ["not-an-email"])).rejects.toThrow(
      "Invalid email address",
    );
    await expect(sendTestSiteAlert(
      supabase,
      12,
      Array.from(
        { length: MAX_SITE_ALERT_RECIPIENTS + 1 },
        (_, index) => `person${index}@example.test`,
      ),
    )).rejects.toThrow("more than 10 unique addresses");
    expect(functionCalls).toEqual([]);
  });
});
