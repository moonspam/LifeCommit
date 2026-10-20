/**
 * 조회 결과 문구·단위·시각 표기의 공용 모음. 카드(패널)와 이후 터미널이 같은 문구를 쓴다.
 * 지금은 ko만. 큰 i18n 프레임워크 없이 locale 키로 고르는 객체 하나.
 * 사람·앱·장소 이름은 번역하지 않는다(기록 그대로).
 */
export type QueryLocale = "ko";

const ko = {
  unsupportedValue: "이해 못 함",
  unsupportedSummary: "지원하지 않는 조건 조합",
  totalUsed: (dur: string) => `총 ${dur} 사용`,
  appRun: "앱 실행",
  unsavedNumbers: "저장 안 된 번호",
  unsavedCountDur: (n: number, dur: string) => `${n}건 · ${dur}`,
  unsavedCount: (n: number) => `저장 안 된 번호 ${n}건`,
  phoneCall: "전화 통화",
  callOnce: "통화 1회",
  callN: (n: number) => `통화 ${n}회`,
  smsConversation: "문자 대화",
  smsOnce: "대화 1회",
  smsN: (n: number) => `대화 ${n}회`,
  reply: "답장",
  replyOnce: (sender: string) => `${sender ? `${sender} ` : ""}답장 1회`,
  visitOnce: (place: string) => `${place} 1회 방문`,
  placeVisit: "장소 방문",
  placeDur: (place: string, dur: string) => `${place} · ${dur}`,
  unitTimes: "회",
  unitConversations: "번 대화",
  totalCount: (n: number, unit: string) => `총 ${n}${unit}`,
  partCall: (n: number) => `통화 ${n}회`,
  partSms: (n: number) => `문자 대화 ${n}`,
  partReply: (n: number) => `메신저 답장 ${n}회`,
  partVisit: (n: number) => `방문 ${n}회`,
  partApp: (n: number) => `앱 실행 ${n}회`,
  omitted: (n: number) => `외 ${n}건의 기록이 생략되었습니다.`,
  recordCount: (n: number) => `${n}개 기록`,
  listSummaryTruncated: (total: number, max: number) => `${total}건 중 ${max}건 표시 (외 ${total - max}건)`,
  listSummary: (total: number) => `${total}건의 기록 목록`,
  hiddenByDefault: "기본 숨김",
  unknownDong: "위치(동 미상)",
  unknownNumber: "알 수 없는 번호",
  // 요청 요약 문장(결과 카드 머리글)
  timeOfDay: { any: "하루 종일", morning: "아침", lunch: "점심", afternoon: "오후", evening: "저녁", night: "밤" } as Record<string, string>,
  kind: { app: "앱", call: "통화", sms: "문자", reply: "답장", location: "장소" } as Record<string, string>,
  metric: { duration: "시간", count: "횟수", list: "목록" } as Record<string, string>,
  allTargets: "전체",
  tagGroup: (tag: string) => `#${tag.replace(/^[#@]/, "")} 묶음`,
  dateRange: (from: string, to: string) => (from === to ? from : `${from} ~ ${to}`),
  summarize: (range: string, tod: string, kind: string, target: string, metric: string) => `${range} · ${tod} · ${kind} ${target} · ${metric}`,
  /** 근거 목록 시각: 하루 초과 기간이면 날짜도 붙인다 */
  rowTime: (ts: number, multiDay: boolean) => {
    const d = new Date(ts);
    const timePart = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    return multiDay ? `${d.getMonth() + 1}/${d.getDate()} ${timePart}` : timePart;
  },
};

export type QueryText = typeof ko;
const TEXTS: Record<QueryLocale, QueryText> = { ko };
export const queryText = (locale: QueryLocale = "ko"): QueryText => TEXTS[locale];
