/**
 * LifeCommit - 연락처 태그 관리 모듈
 */

import { executeInTransaction, getDB } from "./db";
import { emit, EVENT_COMMITS_UPDATED } from "./events";
import { normalizePhone, buildTagMaps, resolvePersonTag } from "./people";

export interface ContactTagItem {
  id: number;
  contact_key?: string;
  contact_name: string;
  tag: string;
  phone_number?: string | null;
}

export interface ContactAutocompleteItem {
  key: string;
  name: string;
  phone: string;
  phoneEnding: string;
  tag: string | null;
  label: string;
}

/**
 * 주소록 조회 로더 인터페이스
 */
export interface PhoneContactsLoader {
  load(): Promise<{ name: string; phone: string }[]>;
  reset(): void;
}

/**
 * 주소록 조회 로더 생성:
 * - full 판일 때만 listContacts 1회 호출 후 결과 캐싱
 * - 진행 중인 호출이 있으면 같은 Promise를 공유하여 중복 호출 방지
 * - oss 판이면 listContacts 호출 0회, 빈 배열 반환
 * - 호출 실패 시 빈 배열 반환
 * - reset() 호출 시 캐시와 진행 중 Promise 초기화
 */
export function createPhoneContactsLoader(
  getFlavorFn: () => Promise<"full" | "oss">,
  listContactsFn: () => Promise<{ contacts: { name: string; phone: string }[] }>
): PhoneContactsLoader {
  let cached: { name: string; phone: string }[] | null = null;
  let inFlight: Promise<{ name: string; phone: string }[]> | null = null;
  let generation = 0;

  return {
    async load(): Promise<{ name: string; phone: string }[]> {
      if (cached !== null) {
        return cached;
      }
      if (inFlight !== null) {
        return inFlight;
      }

      const currentGen = generation;
      inFlight = (async () => {
        try {
          const flavor = await getFlavorFn();
          if (flavor !== "full") {
            if (generation === currentGen) {
              cached = [];
            }
            return [];
          }
          const res = await listContactsFn();
          const contacts = res?.contacts || [];
          if (generation === currentGen) {
            cached = contacts;
          }
          return contacts;
        } catch {
          if (generation === currentGen) {
            cached = [];
          }
          return [];
        } finally {
          if (generation === currentGen) {
            inFlight = null;
          }
        }
      })();

      return inFlight;
    },
    reset(): void {
      generation++;
      cached = null;
      inFlight = null;
    },
  };
}

export interface CandidateSession {
  open(): void;
  close(): void;
  isActive(): boolean;
  begin(): number;
  isCurrent(token: number): boolean;
}

/**
 * 태그 탭 활성 수명(Session) 및 후보 조회 세대(Generation) 관리 객체:
 * - open(): 세션을 활성화하고 이전 세대 토큰을 무효화
 * - close(): 세션을 비활성화하고 진행 중인 세대 토큰을 무효화
 * - isActive(): 현재 세션 활성 여부 반환
 * - begin(): 새로운 후보 조회 세대를 시작하고 토큰 발급
 * - isCurrent(token): 현재 세션이 활성 상태이고 해당 토큰이 최신 세대인지 확인
 */
export function createCandidateSession(): CandidateSession {
  let active = false;
  let generation = 0;

  return {
    open(): void {
      active = true;
      generation++;
    },
    close(): void {
      active = false;
      generation++;
    },
    isActive(): boolean {
      return active;
    },
    begin(): number {
      return ++generation;
    },
    isCurrent(token: number): boolean {
      return active && token === generation;
    },
  };
}


/**
 * 연락처 고유 식별 키 생성 순수 함수:
 * 번호가 있으면 tel:<normalizePhone(번호)>, 없으면 name:<NFC trim 이름>.
 */
export function computeContactKey(contactName: string, phoneNumber?: string | null): string {
  const normPhone = phoneNumber ? normalizePhone(phoneNumber) : "";
  if (normPhone) {
    return `tel:${normPhone}`;
  }
  return `name:${contactName.trim().normalize("NFC")}`;
}

/**
 * 통화/문자 기록 및 기기 주소록 연락처를 normalizePhone 키(tel:) 기준으로 합쳐 자동완성 후보 생성.
 * - 같은 번호면 하나로 병합하며, 주소록 이름 우선(기록의 latestName과 다르면 주소록 이름).
 * - 번호가 정규화되지 않는 항목은 제외.
 * - 이미 태그가 지정되어 있으면 "(#태그)" 표시(resolvePersonTag 규칙).
 */
export function buildContactTagCandidates(
  people: {
    call: { key: string; name: string; saved: boolean; tag: string | null }[];
    sms: { key: string; name: string; saved: boolean; tag: string | null }[];
  },
  phoneContacts?: { name: string; phone: string }[],
  tags?: { contact_key?: string; contact_name: string; tag: string; phone_number?: string | null }[]
): ContactAutocompleteItem[] {
  type TempCandidate = {
    key: string;
    name: string;
    phone: string;
    phoneEnding: string;
    tag: string | null;
  };

  const map = new Map<string, TempCandidate>();

  // 1. 통화/문자 기록 후보 등록
  for (const p of [...people.call, ...people.sms]) {
    if (!p.saved || !p.key.startsWith("tel:")) continue;
    if (map.has(p.key)) continue;
    const normPhone = p.key.slice(4);
    if (!normPhone) continue;
    const ending = normPhone.length >= 4 ? normPhone.slice(-4) : normPhone;
    map.set(p.key, {
      key: p.key,
      name: p.name.trim().normalize("NFC"),
      phone: normPhone,
      phoneEnding: ending,
      tag: p.tag ?? null,
    });
  }

  // 2. 기기 주소록 연락처 병합 (전화번호 정규화 tel: 키 기준)
  if (phoneContacts && Array.isArray(phoneContacts)) {
    for (const c of phoneContacts) {
      if (!c || !c.phone) continue;
      const normPhone = normalizePhone(c.phone);
      if (!normPhone) continue; // 정규화 불가 번호 제외
      const key = `tel:${normPhone}`;
      const ending = normPhone.length >= 4 ? normPhone.slice(-4) : normPhone;
      const cleanName = (c.name || "").trim().normalize("NFC");

      const existing = map.get(key);
      if (existing) {
        // 같은 번호면 하나: 주소록 이름 우선 (기록의 latestName과 다르면 주소록 이름)
        // 후보 phone은 정규화 번호(normalizePhone)로 유지 (주소록 원문으로 덮지 않음)
        if (cleanName) {
          existing.name = cleanName;
        }
      } else {
        map.set(key, {
          key,
          name: cleanName || normPhone,
          phone: normPhone,
          phoneEnding: ending,
          tag: null,
        });
      }
    }
  }

  // 3. 태그 판정 및 라벨 생성
  let tagByName: Map<string, string> | null = null;
  let tagByPhone: Map<string, string> | null = null;
  if (tags && Array.isArray(tags)) {
    const maps = buildTagMaps(tags);
    tagByName = maps.tagByName;
    tagByPhone = maps.tagByPhone;
  }

  const result: ContactAutocompleteItem[] = [];
  for (const item of map.values()) {
    const finalTag = tagByName && tagByPhone
      ? resolvePersonTag(item.name, item.phone, tagByName, tagByPhone)
      : item.tag;
    const tagDisplay = finalTag ? ` (#${finalTag.replace(/^[#@]+/, "")})` : "";
    const label = `${item.name} (…${item.phoneEnding})${tagDisplay}`;
    result.push({
      key: item.key,
      name: item.name,
      phone: item.phone,
      phoneEnding: item.phoneEnding,
      tag: finalTag,
      label,
    });
  }

  return result.sort(
    (a, b) => a.name.localeCompare(b.name, "ko") || a.phone.localeCompare(b.phone)
  );
}

/**
 * 검색어에 따라 연락처 자동완성 후보를 필터링
 * - 검색어에서 숫자만 추출(숫자가 있는 경우)하여 후보의 정규화 번호(phone)에 includes 검색
 * - 이름 검색은 기존대로 NFC 소문자 includes 검색
 */
export function filterContactCandidates(
  candidates: ContactAutocompleteItem[],
  query: string
): ContactAutocompleteItem[] {
  const q = query.trim().normalize("NFC").toLowerCase();
  if (!q) return candidates;
  const digits = q.replace(/\D/g, "");
  return candidates.filter(
    (c) =>
      c.name.normalize("NFC").toLowerCase().includes(q) ||
      (digits.length > 0 && c.phone.includes(digits))
  );
}

/**
 * 직접 입력된 이름과 정확히 일치하는 연락처 후보를 찾아 전화번호를 결정.
 * 정확히 1명만 일치할 때만 번호를 반환하고, 동명이인(2명 이상)이거나 없으면 null을 반환하여
 * 오연결을 방지하고 드롭다운 목록에서 명시적으로 선택하도록 유도.
 */
export function resolvePhoneNumberForName(
  candidates: ContactAutocompleteItem[],
  inputName: string
): string | null {
  const trimmed = inputName.trim();
  if (!trimmed) return null;
  const matches = candidates.filter((c) => c.name === trimmed);
  return matches.length === 1 ? matches[0].phone : null;
}

/**
 * 태그 수정 시 최종 전화번호 결정 순수 함수:
 * - 이름 입력을 건드리지 않은 수정(!nameTouched): 시작 시 읽은 기존 번호(originalPhone)를 유지.
 * - 이름 입력을 건드린 경우(nameTouched): 후보 미일치 직접 입력은 null(번호 해제 -> name: 키),
 *   후보 선택 또는 1명 일치 번호가 있으면 해당 번호 전달.
 */
export function resolveEditPhone(
  originalPhone: string | null | undefined,
  nameTouched: boolean,
  matchedPhone: string | null | undefined
): string | null {
  if (!nameTouched) {
    return originalPhone ?? null;
  }
  return matchedPhone ?? null;
}

/**
 * 연락처 태그 목록 줄에서 표시할 이름 계산:
 * 같은 contact_name을 가진 태그가 둘 이상이면 이름 옆에 번호 끝 4자리 (…1234) 표시.
 * phone_number가 없으면 끝자리 표시 생략.
 */
export function formatContactTagDisplayName(
  tag: { contact_name: string; phone_number?: string | null },
  allTags: { contact_name: string }[]
): string {
  const sameNameCount = allTags.filter(
    (t) => t.contact_name.trim().normalize("NFC") === tag.contact_name.trim().normalize("NFC")
  ).length;
  if (sameNameCount > 1 && tag.phone_number) {
    const digits = tag.phone_number.replace(/\D/g, "");
    const ending = digits.length >= 4 ? digits.slice(-4) : digits;
    if (ending) {
      return `${tag.contact_name} (…${ending})`;
    }
  }
  return tag.contact_name;
}

/**
 * 전체 연락처 태그 목록 조회
 */
export async function fetchContactTags(): Promise<ContactTagItem[]> {
  try {
    const db = getDB();
    const res = await db.query("SELECT * FROM contact_tags ORDER BY id ASC");
    return res.values || [];
  } catch (err) {
    console.error("[TagManager] Fetch failed:", err);
    return [];
  }
}

/**
 * 처리기(CallLog/Sms)에서 사용할 태그 매핑 순수 판정 헬퍼:
 * 번호 일치 우선, 번호 일치 시 태그 행의 contact_name으로 표시 이름 치환.
 * 번호 일치가 없을 때만 번호 없는 행(name: 키)에 한해 이름 매칭(표시 이름 치환 없이 원본 유지).
 */
export function resolveContactTagForProcessor(
  phoneNumber: string | null,
  contactName: string | null,
  tags: { contact_key?: string; contact_name: string; tag: string; phone_number?: string | null }[]
): { authorTag: string | null; resolvedName: string | null } {
  const { tagByName, tagByPhone } = buildTagMaps(tags);
  const normPhone = phoneNumber ? normalizePhone(phoneNumber) : "";
  if (normPhone && tagByPhone.has(normPhone)) {
    const tag = tagByPhone.get(normPhone)!;
    // 번호 일치 행일 때만 태그 행 이름으로 치환
    const matchedTagRow = tags.find((t) => t.phone_number && normalizePhone(t.phone_number) === normPhone);
    return {
      authorTag: tag,
      resolvedName: matchedTagRow ? matchedTagRow.contact_name : contactName,
    };
  }
  // 번호 일치가 없으면 번호 없는 행(name: 키)만 이름으로 매칭
  if (contactName) {
    const clean = contactName.trim().normalize("NFC");
    if (clean && tagByName.has(clean)) {
      return {
        authorTag: tagByName.get(clean)!,
        resolvedName: contactName, // 이름 일치는 덮어쓰지 않고 원래 contactName 유지
      };
    }
  }
  return { authorTag: null, resolvedName: contactName };
}

/**
 * 과거 커밋 author_tag 동기화:
 * 태그 추가·수정·삭제 같은 트랜잭션에서 자동 CALL/SMS 커밋의 author_tag를 새 규칙(번호 우선)으로
 * 다시 계산하여 바뀐 행만 UPDATE (FTS 트리거 자동 갱신).
 * 수동 커밋(manual, QuickCommit)과 subject는 건드리지 않음.
 */
export async function rematchAuthorTags(
  d: { query(sql: string, params?: unknown[]): Promise<{ values?: any[] }>; run(sql: string, params?: unknown[], tx?: boolean): Promise<unknown> }
): Promise<number> {
  const tagRes = await d.query("SELECT contact_key, contact_name, tag, phone_number FROM contact_tags ORDER BY id ASC");
  const tags = tagRes.values || [];
  const { tagByName, tagByPhone } = buildTagMaps(tags);

  const commitRes = await d.query("SELECT id, event_type, body, author_tag FROM commits WHERE event_type IN ('CALL', 'SMS')");
  const commits = commitRes.values || [];

  let changed = 0;
  for (const c of commits) {
    let phone = "";
    let name = "";
    if (typeof c.body === "string") {
      try {
        const b = JSON.parse(c.body);
        phone = b.phoneNumber ? String(b.phoneNumber) : "";
        name = b.contactName ? String(b.contactName) : "";
      } catch {}
    }

    const newTag = resolvePersonTag(name, phone, tagByName, tagByPhone);
    const oldTag = c.author_tag ?? null;
    if (newTag !== oldTag) {
      await d.run("UPDATE commits SET author_tag = ? WHERE id = ?", [newTag, c.id], false);
      changed++;
    }
  }
  return changed;
}

/**
 * 연락처 태그 등록
 */
export async function addContactTag(
  contactName: string,
  tag: string,
  phoneNumber?: string | null
): Promise<void> {
  const trimmedName = contactName.trim().normalize("NFC");
  const trimmedPhone = phoneNumber?.trim() || null;
  const formattedTag = tag.trim().startsWith("#") ? tag.trim() : `#${tag.trim()}`;
  const key = computeContactKey(trimmedName, trimmedPhone);

  await executeInTransaction(async (d) => {
    const existing = await d.query("SELECT 1 FROM contact_tags WHERE contact_key = ?", [key]);
    if (existing.values && existing.values.length > 0) {
      throw new Error("이미 태그가 있는 연락처");
    }
    try {
      await d.run(
        `INSERT INTO contact_tags (contact_key, contact_name, tag, phone_number)
         VALUES (?, ?, ?, ?)`,
        [key, trimmedName, formattedTag, trimmedPhone],
        false
      );
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        throw new Error("이미 태그가 있는 연락처");
      }
      throw err;
    }
    await rematchAuthorTags(d);
  }, { requireTransaction: true });

  emit(EVENT_COMMITS_UPDATED);
}

/**
 * 연락처 태그 수정
 */
export async function updateContactTag(
  id: number,
  contactName: string,
  tag: string,
  phoneNumber?: string | null
): Promise<void> {
  const trimmedName = contactName.trim().normalize("NFC");
  const formattedTag = tag.trim().startsWith("#") ? tag.trim() : `#${tag.trim()}`;

  await executeInTransaction(async (d) => {
    // 번호 보존 규칙: phoneNumber가 undefined이면 기존 phone_number 유지
    let targetPhone: string | null = null;
    if (phoneNumber === undefined) {
      const existingRow = (await d.query("SELECT phone_number FROM contact_tags WHERE id = ?", [id])).values?.[0];
      targetPhone = existingRow?.phone_number ?? null;
    } else {
      targetPhone = phoneNumber?.trim() || null;
    }

    const key = computeContactKey(trimmedName, targetPhone);
    const duplicate = await d.query("SELECT 1 FROM contact_tags WHERE contact_key = ? AND id != ?", [key, id]);
    if (duplicate.values && duplicate.values.length > 0) {
      throw new Error("이미 태그가 있는 연락처");
    }

    try {
      await d.run(
        `UPDATE contact_tags 
         SET contact_key = ?, contact_name = ?, tag = ?, phone_number = ?
         WHERE id = ?`,
        [key, trimmedName, formattedTag, targetPhone, id],
        false
      );
    } catch (err: any) {
      if (String(err?.message || err).includes("UNIQUE")) {
        throw new Error("이미 태그가 있는 연락처");
      }
      throw err;
    }

    await rematchAuthorTags(d);
  }, { requireTransaction: true });

  emit(EVENT_COMMITS_UPDATED);
}

/**
 * 연락처 태그 삭제
 */
export async function deleteContactTag(id: number): Promise<void> {
  await executeInTransaction(async (d) => {
    await d.run("DELETE FROM contact_tags WHERE id = ?", [id], false);
    await rematchAuthorTags(d);
  }, { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
}
