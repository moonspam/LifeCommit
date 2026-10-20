import type { Commit } from "../types/commit";
import { resolveAppName } from "./processor/utils";

/**
 * LifeCommit+ people diagram data: who the user interacted with in a period - calls, SMS, and messenger replies the user
 * sent. Only the user's own interactions exist (no links between other people, no unanswered messenger messages - the
 * app never stores notifications), so the shape is "me" in the middle. Computed on the fly, nothing stored.
 */
export type Person = {
  key: string; name: string; tag: string | null;
  /** Eligible for the default list; false for unsaved phone numbers and number-shaped messenger names. */
  saved: boolean;
  calls: number; callSec: number; sms: number; replies: number; score: number;
  lastAt: number; lastKind: "CALL" | "SMS" | "REPLY";
};

/** One person per phone number: digits only, +82 / 82 prefix -> 0 (including a redundant 0 after +82). */
export function normalizePhone(p: string): string {
  const d = String(p).replace(/\D/g, "");
  return d.startsWith("82") && d.length >= 9 ? "0" + d.slice(2).replace(/^0/, "") : d;
}

const HALF_LIFE_DAYS = 14;
const body = (c: Commit): Record<string, any> => { try { return JSON.parse(c.body ?? "{}") ?? {}; } catch { return {}; } };

/**
 * Closeness = sum of interactions, each weighted by recency (half-life 14 days before `asOf`); a call adds up to 3 more
 * for its length (30 min cap). Missed / rejected calls do not count (spam would rank first). Unsaved numbers are kept
 * apart (`saved: false`), shown only on request. Messenger senders are keyed by app + display name and never merged
 * with phone contacts: a display name is not a person identifier.
 */
export function buildTagMaps(tags: { contact_name: string; tag: string; phone_number?: string | null; contact_key?: string }[] = []) {
  const tagByName = new Map<string, string>();
  const tagByPhone = new Map<string, string>();

  for (const t of tags) {
    const phone = t.phone_number ? normalizePhone(t.phone_number) : "";
    if (phone) {
      tagByPhone.set(phone, t.tag);
    } else {
      const cleanName = t.contact_name ? t.contact_name.trim().normalize("NFC") : "";
      if (cleanName) {
        tagByName.set(cleanName, t.tag);
      }
    }
  }
  return { tagByName, tagByPhone };
}

export function resolvePersonTag(
  name: string,
  phone: string | null,
  tagByName: Map<string, string>,
  tagByPhone: Map<string, string>
): string | null {
  if (phone) {
    const norm = normalizePhone(phone);
    if (norm && tagByPhone.has(norm)) {
      return tagByPhone.get(norm)!;
    }
  }
  if (name) {
    const clean = name.trim().normalize("NFC");
    if (clean && tagByName.has(clean)) {
      return tagByName.get(clean)!;
    }
  }
  return null;
}

export function buildPeople(commits: Commit[], asOf: number, tags: { contact_name: string; tag: string; phone_number?: string | null; contact_key?: string }[] = [],
  period?: { start: number; end: number }): Person[] {
  const byKey = new Map<string, Person>();
  const { tagByName, tagByPhone } = buildTagMaps(tags);
  const recency = (t: number) => Math.pow(0.5, Math.max(0, asOf - t) / 86_400_000 / HALF_LIFE_DAYS);
  const person = (key: string, name: string, saved: boolean, phone: string | null,
    at: number, kind: Person["lastKind"], displayName = name) => {
    let p = byKey.get(key);
    if (!p) byKey.set(key, (p = { key, name: displayName, tag: kind === "REPLY" ? null : resolvePersonTag(name, phone, tagByName, tagByPhone), saved,
      calls: 0, callSec: 0, sms: 0, replies: 0, score: 0, lastAt: at, lastKind: kind }));
    if (at > p.lastAt) { p.lastAt = at; p.lastKind = kind; }
    return p;
  };
  const replies: Commit[] = [];
  for (const c of commits) {
    if (period && (c.startedAt < period.start || c.startedAt > period.end)) continue;
    if (c.eventType === "REPLY") { replies.push(c); continue; }
    if (c.eventType !== "CALL" && c.eventType !== "SMS") continue;
    const b = body(c);
    if (c.eventType === "CALL" && (b.callType === "MISSED" || b.callType === "REJECTED")) continue;
    const phone = normalizePhone(b.phoneNumber ?? "");
    if (!phone) continue;
    const name = b.contactName || `…${phone.slice(-4)}`;
    const p = person(`tel:${phone}`, name, !!b.contactName, phone, c.startedAt, c.eventType);
    if (b.contactName && !p.saved) { p.name = b.contactName; p.saved = true; } // a later row carries the saved name
    if (c.eventType === "CALL") {
      const sec = Number(b.durationSec) || 0;
      p.calls++; p.callSec += sec; p.score += (1 + Math.min(sec / 60, 30) / 10) * recency(c.startedAt);
    } else { p.sms++; p.score += recency(c.startedAt); }
  }
  for (const c of replies) {
    const b = body(c);
    const sender = String(b.sender ?? "").trim();
    if (!sender || sender === "알 수 없음") continue;
    const app = String(b.packageName ?? c.appPackage ?? "");
    const digits = sender.normalize("NFKC").replace(/[\s\u00a0\p{Pd}\u2010-\u2015\u2212.·()+\/]/gu, "");
    const numberLike = isNumberLikeSender(sender);
    const p = person(`msg:${app}:${sender}`, sender, !numberLike, null, c.startedAt, "REPLY",
      numberLike ? `…${digits.slice(-4)}` : `${sender} · ${resolveAppName(app)}`);
    p.replies++; p.score += recency(c.startedAt);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** 번호형 발신자 판정: 구분 기호 제거 후 전체가 7자리 이상 숫자인지 확인 (관계도·검색 공용, NL1-7 #3) */
export function isNumberLikeSender(sender: string): boolean {
  if (!sender) return false;
  const digits = sender.normalize("NFKC").replace(/[\s\u00a0\p{Pd}\u2010-\u2015\u2212.·()+\/]/gu, "");
  return /^\d{7,}$/.test(digits);
}

/** The diagram shows the top `limit` (saved people unless `withUnsaved`); the rest is "외 N명". */
export function topPeople(people: Person[], limit = 15, withUnsaved = false) {
  const shown = people.filter((p) => withUnsaved || p.saved);
  return { top: shown.slice(0, limit), others: shown.length - Math.min(limit, shown.length), unsaved: people.filter((p) => !p.saved).length };
}

/** Add phone endings only to display labels of saved phone contacts whose names collide in this period. */
export function peopleDisplayLabels(people: Person[]): Map<string, { full: string; node: string }> {
  const phoneNames = new Map<string, string[]>();
  for (const p of people) if (p.saved && p.key.startsWith("tel:")) {
    const phones = phoneNames.get(p.name) ?? [];
    phones.push(p.key.slice(4));
    phoneNames.set(p.name, phones);
  }
  const widths = new Map([...phoneNames].filter(([, phones]) => phones.length > 1).map(([name, phones]) => [name,
    [4, 6, 8, Infinity].find((width) => new Set(phones.map((phone) => phone.slice(-width))).size === phones.length)!]));
  return new Map(people.map((p) => {
    const width = p.saved && p.key.startsWith("tel:") ? widths.get(p.name) : undefined;
    const duplicate = width !== undefined;
    const suffix = duplicate ? ` (${width === Infinity ? p.key.slice(4) : `…${p.key.slice(-width)}`})` : "";
    const nodeBase = p.name.length > (duplicate ? 4 : 7) ? p.name.slice(0, duplicate ? 4 : 7) + "…" : p.name;
    return [p.key, { full: p.name + suffix, node: nodeBase + suffix }];
  }));
}
