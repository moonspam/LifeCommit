"use client";

import { useEffect, useState } from "react";
import { getPeopleCommitsByPeriod } from "@/lib/queries";
import { fetchContactTags } from "@/lib/tagManager";
import { buildPeople, peopleDisplayLabels, topPeople, type Person } from "@/lib/people";
import { layoutPeopleGraph, PEOPLE_GRAPH } from "@/lib/peopleLayout";
import { useBackClose } from "@/lib/back";

/** Only the user's calls, SMS conversations and sent replies are represented here. */
const CHANNEL = { call: "#79c0ff", sms: "#d2a8ff", reply: "#39d353" } as const;
const TAG_COLORS = ["#e3b341", "#f78166", "#56d4dd", "#ff7eb6", "#a5d6ff"];
const channelOf = (p: Person) => (p.calls >= p.sms && p.calls >= p.replies ? "call" : p.sms >= p.replies ? "sms" : "reply");
const lastKind = { CALL: "통화", SMS: "문자 대화", REPLY: "메신저 답장" } as const;
const duration = (sec: number) => sec < 60 ? `${sec}초` : sec < 3600 ? `${Math.floor(sec / 60)}분`
  : `${Math.floor(sec / 3600)}시간${Math.floor(sec % 3600 / 60) ? ` ${Math.floor(sec % 3600 / 60)}분` : ""}`;
const lastTime = (at: number) => {
  const d = new Date(at), today = new Date(), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = d.toDateString() === today.toDateString() ? "오늘" : d.toDateString() === yesterday.toDateString() ? "어제"
    : `${d.getMonth() + 1}/${d.getDate()}`;
  return `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function PeopleGraph({ start, end, resumeTick, periodLabel }: { start: number; end: number; resumeTick: number; periodLabel: string }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [withUnsaved, setWithUnsaved] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null | undefined>(undefined);

  useBackClose(selectedKey !== null && selectedKey !== undefined, () => setSelectedKey(null));

  useEffect(() => {
    let active = true;
    void Promise.all([getPeopleCommitsByPeriod(start, end), fetchContactTags()]).then(([rows, tags]) => {
      if (active) setPeople(buildPeople(rows, Math.min(end, Date.now()), tags, { start, end }));
    });
    return () => { active = false; };
  }, [start, end, resumeTick]);
  useEffect(() => { setSelectedKey(undefined); }, [start, end]);

  return <PeopleGraphView people={people} withUnsaved={withUnsaved} selectedKey={selectedKey} periodLabel={periodLabel}
    onSelect={(key) => setSelectedKey(key)} onToggle={() => setWithUnsaved((v) => !v)} />;
}

export function PeopleGraphView({ people, withUnsaved, selectedKey, periodLabel, onSelect, onToggle }: {
  people: Person[]; withUnsaved: boolean; selectedKey: string | null | undefined; periodLabel: string;
  onSelect: (key: string | null) => void; onToggle: () => void;
}) {
  const { top, unsaved } = topPeople(people, 15, withUnsaved);
  const { top: ranked, others } = topPeople(people, 5, withUnsaved);
  const selected = selectedKey === null ? undefined : top.find((p) => p.key === selectedKey) ?? top[0];
  const labels = peopleDisplayLabels(people);
  const tags = [...new Set(top.map((p) => p.tag).filter((tag): tag is string => !!tag))];
  const colorOf = (p: Person) => p.tag ? TAG_COLORS[tags.indexOf(p.tag) % TAG_COLORS.length] : CHANNEL[channelOf(p)];
  const canvas = typeof document === "undefined" ? null : document.createElement("canvas");
  const context = canvas?.getContext("2d");
  if (context) context.font = "10.5px monospace";
  const measure = (text: string) => context?.measureText(text).width ?? Array.from(text).length * 10.5;
  const { nodes, rings } = layoutPeopleGraph(top, labels, measure);
  const maxScore = Math.max(...top.map((p) => p.score), 1e-9);
  const hot = new Set(top.slice(0, 3).map((p) => p.key));
  const choose = (p: Person) => onSelect(selected?.key === p.key ? null : p.key);
  const avatar = (p: Person, className: string) => <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold ${className}`}
    style={{ backgroundColor: `${colorOf(p)}33`, color: colorOf(p), border: `1.5px solid ${colorOf(p)}` }}>
    {Array.from(p.name)[0]}
  </span>;
  const bar = (p: Person) => {
    const total = p.calls + p.sms + p.replies;
    return <span className="mt-1.5 flex h-1.5 w-full overflow-hidden rounded-full bg-terminal-bg" aria-label="채널별 비율">
      {([ ["call", p.calls], ["sms", p.sms], ["reply", p.replies] ] as const).filter(([, count]) => count > 0)
        .map(([channel, count]) => <span key={channel} style={{ width: `${count / total * 100}%`, backgroundColor: CHANNEL[channel] }} />)}
    </span>;
  };

  return <section className="flex flex-col gap-3 rounded-2xl border border-terminal-border bg-terminal-surface p-3 font-mono text-terminal-white sm:p-4">
    <div className="flex items-start justify-between gap-2">
      <span className="text-[11px] tracking-[0.12em] text-terminal-gray">PEOPLE · {periodLabel}</span>
      {unsaved > 0 && <button type="button" onClick={onToggle} className="text-right text-[11px] text-terminal-blue">
        {withUnsaved ? "저장된 연락처만" : `저장 안 된 번호 ${unsaved}개 보기`}
      </button>}
    </div>
    <p className="text-[11px] text-terminal-gray">가까울수록 최근에 자주 연락했어요</p>
    {top.length === 0 ? <p className="py-12 text-center text-xs text-terminal-gray">이 기간의 통화·문자·답장이 없습니다.</p> : <>
      <svg viewBox={`0 0 ${PEOPLE_GRAPH.width} ${PEOPLE_GRAPH.height}`} width="100%" className="w-full" role="group" aria-label="인간관계 다이어그램">
        {PEOPLE_GRAPH.rings.map((radius) => <circle key={radius} cx={PEOPLE_GRAPH.cx} cy={PEOPLE_GRAPH.cy} r={radius}
          fill="none" stroke="#30363d" strokeDasharray="2 5" />)}
        {rings.map((ring) => <text key={ring.text} x={ring.x} y={ring.y + 9} fontSize={9} fontFamily="monospace" fill="#8b949e">
          {ring.text}</text>)}
        {nodes.map(({ person: p, x, y, radius }) => {
          const dx = x - PEOPLE_GRAPH.cx;
          const dy = y - PEOPLE_GRAPH.cy;
          const dist = Math.hypot(dx, dy);
          const ux = dist ? dx / dist : 0;
          const uy = dist ? dy / dist : 0;
          const nodeR = hot.has(p.key) ? radius + 5 : radius;
          const x1 = PEOPLE_GRAPH.cx + ux * 22;
          const y1 = PEOPLE_GRAPH.cy + uy * 22;
          const x2 = x - ux * nodeR;
          const y2 = y - uy * nodeR;
          return <line key={`line-${p.key}`} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={colorOf(p)} strokeOpacity={0.18 + 0.55 * p.score / maxScore} strokeWidth={0.8 + 3.2 * p.score / maxScore} strokeLinecap="round" />;
        })}
        <circle cx={PEOPLE_GRAPH.cx} cy={PEOPLE_GRAPH.cy} r={22} fill="#161b22" stroke="#39d353" strokeWidth={2.5} />
        <text x={PEOPLE_GRAPH.cx} y={PEOPLE_GRAPH.cy + 5} textAnchor="middle" fontSize={13} fontWeight="bold" fontFamily="monospace" fill="#c9d1d9">나</text>
        {nodes.map(({ person: p, x, y, radius }) => <g key={`circle-${p.key}`} onClick={() => choose(p)} className="cursor-pointer">
          {hot.has(p.key) && <circle cx={x} cy={y} r={radius + 5} fill="none" stroke={colorOf(p)}
            strokeOpacity={selected?.key === p.key ? 0.75 : 0.35} strokeWidth={selected?.key === p.key ? 3 : 1.5} />}
          <circle cx={x} cy={y} r={radius} fill="#161b22" />
          <circle cx={x} cy={y} r={radius} fill={colorOf(p)} fillOpacity={0.25} stroke={colorOf(p)} strokeWidth={1.8} />
          <text x={x} y={y + 4.5} textAnchor="middle" fontSize={Math.max(11, radius * 0.85)} fontWeight="bold"
            fontFamily="monospace" fill={colorOf(p)}>{Array.from(p.name)[0]}</text>
        </g>)}
        {nodes.map(({ person: p, label }) => <g key={p.key} role="button" tabIndex={0}
          aria-label={labels.get(p.key)?.full ?? p.name} aria-pressed={selected?.key === p.key}
          onClick={() => choose(p)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(p); } }}
          className="cursor-pointer">
          <rect x={label.x} y={label.y} width={label.width} height={18} rx={9} fill="#0d1117" stroke="#30363d" />
          <text x={label.x + label.width / 2} y={label.y + 12} textAnchor="middle" fontSize={10.5 * label.fontScale}
            fontFamily="monospace" fill="#c9d1d9">{label.text}</text>
        </g>)}
      </svg>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag, i) => <span key={tag} className="rounded-full border border-terminal-border bg-[#1c2330] px-2 py-0.5 text-[11px] text-terminal-gray">
          <span style={{ color: TAG_COLORS[i % TAG_COLORS.length] }}>●</span> {tag}</span>)}
        {([ ["call", "통화"], ["sms", "문자 대화"], ["reply", "메신저 답장"] ] as const).map(([channel, title]) =>
          <span key={channel} className="rounded-full border border-terminal-border bg-[#1c2330] px-2 py-0.5 text-[11px] text-terminal-gray">
            <span style={{ color: CHANNEL[channel] }}>●</span> {title}</span>)}
      </div>
      {selected && <div className="rounded-xl border p-3" style={{ borderColor: `${colorOf(selected)}66`,
        background: `linear-gradient(180deg, ${colorOf(selected)}14, transparent)` }}>
        <div className="flex items-center gap-2.5">
          {avatar(selected, "h-9 w-9 text-sm")}
          <div className="min-w-0">
            <div className="break-words text-sm font-semibold">{labels.get(selected.key)?.full ?? selected.name}
              {selected.tag && <span className="ml-2 text-xs" style={{ color: colorOf(selected) }}>{selected.tag}</span>}</div>
            <div className="text-[11px] text-terminal-gray">마지막 연락 · {lastTime(selected.lastAt)} ({lastKind[selected.lastKind]})</div>
          </div>
        </div>
        <div className="mt-2 flex justify-between text-xs text-terminal-gray" aria-label={`통화 ${selected.calls}회 · ${duration(selected.callSec)}`}>
          <span>📞 통화</span><b className="text-terminal-white">{selected.calls ? `${selected.calls}회 · ${duration(selected.callSec)}` : "-"}</b></div>
        <div className="mt-1.5 flex justify-between text-xs text-terminal-gray" aria-label={`문자 대화 ${selected.sms}`}>
          <span>💬 문자 대화</span><b className="text-terminal-white">{selected.sms || "-"}</b></div>
        <div className="mt-1.5 flex justify-between text-xs text-terminal-gray" aria-label={`메신저 답장 ${selected.replies}`}>
          <span>↩︎ 메신저 답장</span><b className="text-terminal-white">{selected.replies || "-"}</b></div>
      </div>}
      <div className="flex flex-col gap-2">
        {ranked.map((p, i) => <button type="button" key={p.key} onClick={() => choose(p)}
          aria-label={`${labels.get(p.key)?.full ?? p.name} 순위`} aria-pressed={selected?.key === p.key}
          className="grid w-full grid-cols-[20px_32px_minmax(0,1fr)] min-[320px]:grid-cols-[20px_32px_minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-terminal-border bg-[#1c2330] px-2 py-2 text-left sm:grid-cols-[24px_34px_minmax(0,1fr)_auto] sm:gap-2.5">
          <span className="text-right text-xs text-terminal-gray">{i + 1}</span>
          {avatar(p, "h-8 w-8 text-xs sm:h-[34px] sm:w-[34px]")}
          <span className="min-w-0">
            <span className="flex flex-wrap items-baseline text-xs">
              <span className="min-w-[4ch] truncate">{p.name}
                {p.tag && <span className="ml-1 text-[11px]" style={{ color: colorOf(p) }}>{p.tag}</span>}</span>
              <span className="shrink-0 whitespace-pre">{labels.get(p.key)?.full.slice(p.name.length)}</span>
            </span>
            {bar(p)}
          </span>
          <span className="min-w-0 col-span-full min-[320px]:col-auto text-right text-[10px] leading-relaxed text-terminal-gray">
            <span className="block whitespace-nowrap">{[p.calls && `📞${p.calls}`, p.sms && `💬${p.sms}`, p.replies && `↩︎${p.replies}`].filter(Boolean).join(" ")}</span>
            <span className="block whitespace-nowrap">{lastTime(p.lastAt)}</span>
            <span className="sr-only">문자 대화 {p.sms}</span>
          </span>
        </button>)}
        {others > 0 && <span className="text-center text-[11px] text-terminal-gray">외 {others}명</span>}
      </div>
    </>}
    <p className="text-[10px] leading-relaxed text-terminal-gray/70">내가 한 통화·문자와 메신저에서 보낸 답장만으로 그립니다. 짧은 간격의 문자는 한 대화로 묶여 셉니다. 메신저 상대는 앱에 보이는 이름 단위이며, 같은 이름이라도 같은 사람이라는 보장이 없습니다. 번호로만 된 메신저 이름은 기본으로 숨기지만, 이름 안에 들어 있는 번호는 그대로 표시됩니다. 다른 사람들 사이의 관계나 답장하지 않은 메신저 대화는 알 수 없습니다. 기기 안에서만 계산합니다.</p>
  </section>;
}
