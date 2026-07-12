import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { invokeFunction } from "./supabase.js";
import { normalizeEmailList, parsePositiveInteger } from "./validation.js";

export const SITE_ALERT_ACTIONS = ["status", "save", "send_test"] as const;
export const MAX_SITE_ALERT_RECIPIENTS = 10;
export const SITE_ALERT_DEFAULTS = {
  enabled: false,
  uptimeEnabled: true,
  uptimeThresholdMinutes: 10,
  performanceEnabled: true,
  performanceThreshold: 70,
  seoCriticalEnabled: true,
  notifyOnRecovery: true,
} as const;

export type SiteAlertAction = (typeof SITE_ALERT_ACTIONS)[number];
export type SiteAlertUnknownFields = Record<string, unknown>;

export interface SiteAlertSetting extends SiteAlertUnknownFields {
  site_id: number;
  enabled: boolean;
  uptime_enabled: boolean;
  uptime_threshold_minutes: number;
  performance_enabled: boolean;
  performance_threshold: number;
  seo_critical_enabled: boolean;
  notify_on_recovery: boolean;
  recipients: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface SiteAlertCondition extends SiteAlertUnknownFields {
  available?: boolean;
  breached?: boolean;
  currentValue?: unknown;
  summary?: string;
}

export interface SiteAlertIncident extends SiteAlertUnknownFields {
  id?: string;
  alert_type?: string;
  status?: string;
  summary?: string;
  threshold_value?: unknown;
  current_value?: unknown;
  details?: SiteAlertUnknownFields;
  triggered_at?: string | null;
}

export interface SiteAlertEvent extends SiteAlertUnknownFields {
  id?: string;
  alert_type?: string;
  event_type?: string;
  severity?: string;
  summary?: string;
  recipients?: string[];
  delivery_status?: string;
  delivered_at?: string | null;
  error_message?: string | null;
  created_at?: string | null;
}

export interface SiteAlertsStatus extends SiteAlertUnknownFields {
  configured: boolean;
  setting: SiteAlertSetting;
  conditions: Record<string, SiteAlertCondition>;
  incidents: SiteAlertIncident[];
  events: SiteAlertEvent[];
}

export interface SaveSiteAlertsOptions {
  enabled: boolean;
  recipients?: readonly string[];
  uptimeEnabled?: boolean;
  uptimeThresholdMinutes?: number;
  performanceEnabled?: boolean;
  performanceThreshold?: number;
  seoCriticalEnabled?: boolean;
  notifyOnRecovery?: boolean;
}

export interface SaveSiteAlertsResult extends SiteAlertUnknownFields {
  setting: SiteAlertSetting;
  evaluation: unknown;
  incidents: SiteAlertIncident[];
  events: SiteAlertEvent[];
}

export interface SendTestSiteAlertResult extends SiteAlertUnknownFields {
  event: SiteAlertEvent;
}

function normalizeSiteId(siteId: string | number): number {
  return parsePositiveInteger(siteId, "siteId", { min: 1 });
}

function normalizeRecipients(
  recipients: readonly string[] | undefined,
  required: boolean,
): string[] {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    if (required) throw new CliError("At least one alert recipient is required.");
    return [];
  }
  return normalizeEmailList([...recipients], { max: MAX_SITE_ALERT_RECIPIENTS });
}

export async function getSiteAlerts(
  supabase: SupabaseClient,
  siteId: string | number,
): Promise<SiteAlertsStatus> {
  return invokeFunction<SiteAlertsStatus>(supabase, "site-alerts", {
    action: "status",
    site_id: normalizeSiteId(siteId),
  });
}

export async function saveSiteAlerts(
  supabase: SupabaseClient,
  siteId: string | number,
  options: SaveSiteAlertsOptions,
): Promise<SaveSiteAlertsResult> {
  const enabled = options.enabled === true;
  const uptimeEnabled = options.uptimeEnabled ?? SITE_ALERT_DEFAULTS.uptimeEnabled;
  const performanceEnabled = options.performanceEnabled ?? SITE_ALERT_DEFAULTS.performanceEnabled;
  const seoCriticalEnabled = options.seoCriticalEnabled ?? SITE_ALERT_DEFAULTS.seoCriticalEnabled;
  const recipients = normalizeRecipients(options.recipients, enabled);

  if (enabled && !uptimeEnabled && !performanceEnabled && !seoCriticalEnabled) {
    throw new CliError("Enable at least one alert rule.");
  }

  const uptimeThresholdMinutes = parsePositiveInteger(
    options.uptimeThresholdMinutes ?? SITE_ALERT_DEFAULTS.uptimeThresholdMinutes,
    "uptime threshold",
    { min: 5, max: 1440 },
  );
  const performanceThreshold = parsePositiveInteger(
    options.performanceThreshold ?? SITE_ALERT_DEFAULTS.performanceThreshold,
    "performance threshold",
    { min: 1, max: 100 },
  );

  return invokeFunction<SaveSiteAlertsResult>(supabase, "site-alerts", {
    action: "save",
    site_id: normalizeSiteId(siteId),
    enabled,
    uptime_enabled: uptimeEnabled,
    uptime_threshold_minutes: uptimeThresholdMinutes,
    performance_enabled: performanceEnabled,
    performance_threshold: performanceThreshold,
    seo_critical_enabled: seoCriticalEnabled,
    notify_on_recovery: options.notifyOnRecovery ?? SITE_ALERT_DEFAULTS.notifyOnRecovery,
    recipients,
  });
}

export async function sendTestSiteAlert(
  supabase: SupabaseClient,
  siteId: string | number,
  recipients: readonly string[],
): Promise<SendTestSiteAlertResult> {
  return invokeFunction<SendTestSiteAlertResult>(supabase, "site-alerts", {
    action: "send_test",
    site_id: normalizeSiteId(siteId),
    recipients: normalizeRecipients(recipients, true),
  });
}
