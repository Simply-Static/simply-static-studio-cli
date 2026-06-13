import type { SupabaseClient } from "@supabase/supabase-js";
import { CliError } from "./errors.js";
import { assertSafeId, normalizeHexColor, normalizeTagName } from "./validation.js";

export interface TagRecord {
  id: string | number;
  account_id?: string;
  name: string;
  color?: string;
  [key: string]: unknown;
}

export async function listTags(
  supabase: SupabaseClient,
  accountId: string,
): Promise<TagRecord[]> {
  const safeAccountId = assertSafeId(accountId, "accountId");
  const { data, error } = await supabase
    .from("tag")
    .select("id, account_id, name, color, created_at")
    .eq("account_id", safeAccountId)
    .order("name", { ascending: true });

  if (error) throw new CliError(error.message);
  return (data || []) as TagRecord[];
}

export async function listSiteTags(
  supabase: SupabaseClient,
  siteId: string,
): Promise<TagRecord[]> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const { data, error } = await supabase
    .from("site_tag")
    .select("tag_id, tag(id, account_id, name, color)")
    .eq("site_id", safeSiteId);

  if (error) throw new CliError(error.message);
  return (data || [])
    .map((row) => row.tag)
    .filter(Boolean) as unknown as TagRecord[];
}

export async function createTag(
  supabase: SupabaseClient,
  accountId: string,
  name: string,
  color: string,
): Promise<TagRecord> {
  const safeAccountId = assertSafeId(accountId, "accountId");
  const { data, error } = await supabase
    .from("tag")
    .insert({
      account_id: safeAccountId,
      name: normalizeTagName(name),
      color: normalizeHexColor(color),
    })
    .select()
    .single();

  if (error) throw new CliError(error.message);
  return data as TagRecord;
}

export async function updateTag(
  supabase: SupabaseClient,
  tagId: string,
  changes: { name?: string; color?: string },
): Promise<TagRecord> {
  const safeTagId = assertSafeId(tagId, "tagId");
  const update: Record<string, string> = {};
  if (changes.name !== undefined) update.name = normalizeTagName(changes.name);
  if (changes.color !== undefined) update.color = normalizeHexColor(changes.color);
  if (Object.keys(update).length === 0) {
    throw new CliError("No tag changes supplied.");
  }

  const { data, error } = await supabase.from("tag").update(update).eq("id", safeTagId).select().single();
  if (error) throw new CliError(error.message);
  return data as TagRecord;
}

export async function deleteTag(supabase: SupabaseClient, tagId: string): Promise<{ deleted: true; tagId: string }> {
  const safeTagId = assertSafeId(tagId, "tagId");
  const { error } = await supabase.from("tag").delete().eq("id", safeTagId);
  if (error) throw new CliError(error.message);
  return { deleted: true, tagId: safeTagId };
}

export async function assignTagToSite(
  supabase: SupabaseClient,
  siteId: string,
  tagId: string,
): Promise<{ assigned: true; siteId: string; tagId: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeTagId = assertSafeId(tagId, "tagId");
  const { error } = await supabase.from("site_tag").insert({ site_id: safeSiteId, tag_id: safeTagId });
  if (error && error.code !== "23505") throw new CliError(error.message);
  return { assigned: true, siteId: safeSiteId, tagId: safeTagId };
}

export async function removeTagFromSite(
  supabase: SupabaseClient,
  siteId: string,
  tagId: string,
): Promise<{ removed: true; siteId: string; tagId: string }> {
  const safeSiteId = assertSafeId(siteId, "siteId");
  const safeTagId = assertSafeId(tagId, "tagId");
  const { error } = await supabase.from("site_tag").delete().eq("site_id", safeSiteId).eq("tag_id", safeTagId);
  if (error) throw new CliError(error.message);
  return { removed: true, siteId: safeSiteId, tagId: safeTagId };
}
