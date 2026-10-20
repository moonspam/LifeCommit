import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeopleGraphView } from "../components/Stats/PeopleGraph";
import { PEOPLE_GRAPH } from "./peopleLayout";
import type { Person } from "./people";

const NOW = 1_800_000_000_000;
const fake = (i: number, extras: Partial<Person> = {}): Person => ({ key: `tel:0100000000${i}`, name: `Person ${i}`, tag: null,
  saved: true, calls: i + 1, callSec: 120, sms: 1, replies: 0, score: 10 - i, lastAt: NOW - i * 60_000,
  lastKind: "CALL", ...extras });
const render = (people: Person[], withUnsaved = false, selectedKey: string | null | undefined = undefined) =>
  renderToStaticMarkup(createElement(PeopleGraphView, { people, withUnsaved, selectedKey, periodLabel: "이번 주",
    onSelect: () => {}, onToggle: () => {} }));

// The full mock layout shows a default detail, five ranked cards and a channel mix, while graph labels stay separate.
{
  const people = Array.from({ length: 8 }, (_, i) => fake(i));
  const html = render(people);
  assert.ok(html.includes("PEOPLE · 이번 주"));
  assert.ok(html.includes("마지막 연락"));
  assert.ok(html.includes("통화 1회"));
  assert.ok(html.includes("문자 대화 1"));
  assert.ok(html.includes("메신저 답장"));
  assert.ok(html.includes("외 3명"));
  assert.equal((html.match(/aria-label="[^"]* 순위"/g) ?? []).length, 5);
  assert.ok(html.includes('aria-pressed="true"'), "the first person is selected by default");
  assert.ok(html.includes("width:50%"), "a two-channel person receives a proportional bar");
}
// Hidden numbers remain masked everywhere, including detail and graph, and a deselected card stays closed.
{
  const people = [fake(1), fake(2, { key: "tel:01098765432", name: "…5432", saved: false, score: 20 })];
  const hidden = render(people);
  assert.ok(hidden.includes("저장 안 된 번호 1개 보기"));
  assert.ok(!hidden.includes("…5432"));
  const shown = render(people, true);
  assert.ok(shown.includes("…5432"));
  assert.ok(!shown.includes("01098765432"));
  assert.ok(!render([fake(1)], false, null).includes("마지막 연락"), "tapping again can close detail");
  assert.ok(render([fake(1)]).includes("마지막 연락"));
  assert.ok(render([]).includes("이 기간의 통화·문자·답장이 없습니다"));
}
// A mixed name can expose embedded digits; the same precise warning belongs in the UI and README.
{
  const warning = "번호로만 된 메신저 이름은 기본으로 숨기지만, 이름 안에 들어 있는 번호는 그대로 표시됩니다.";
  const html = render([fake(1, { key: "msg:fake:Test 010-0000-0000", name: "Test 010-0000-0000 · TestApp" })]);
  assert.ok(html.includes(warning));
  assert.ok(readFileSync("README.md", "utf8").includes(warning));
}
// Ranked duplicate names truncate independently of their distinguishing phone suffix.
for (const name of ["아주긴동명이인이름", "아주긴동명이인이름".repeat(3)]) {
  const html = render([fake(0, { name, key: "tel:01011111234" }), fake(1, { name, key: "tel:01111111234" })]);
  const cards = html.match(/<button[^>]*aria-label="[^"]* 순위"[\s\S]*?<\/button>/g) ?? [];
  assert.equal(cards.length, 2);
  cards.forEach((card, i) => {
    const suffix = card.match(/<span class="([^"]*)"> \((\d+)\)<\/span>/);
    assert.ok(suffix, "phone suffix must be a separate element");
    assert.equal(suffix[2], i === 0 ? "01011111234" : "01111111234");
    assert.ok(suffix[1].split(" ").includes("shrink-0"));
    assert.ok(!/truncate|overflow-hidden/.test(suffix[1]));
    assert.ok(card.includes(`<span class="min-w-[4ch] truncate">${name}`));
    assert.ok(card.includes('flex flex-wrap items-baseline text-xs'), "280px 극단 폭에서 이름 최소 폭 보장 및 접미사 flex-wrap 줄바꿈 지원");
    assert.ok(card.includes("grid-cols-[20px_32px_minmax(0,1fr)]"), "280px 기본은 3열 그리드로 이름/접미사가 카드 잔여 폭을 차지");
    assert.ok(card.includes("min-[320px]:grid-cols-[20px_32px_minmax(0,1fr)_auto]"), "320px 이상에서는 기존 4열 그리드 배치 유지");
    assert.ok(card.includes("col-span-full"), "280px에서 우측 통계/시각이 카드 전체 폭의 별도 grid 행 분리");
    assert.ok(card.includes("min-[320px]:col-auto"), "320px 이상에서는 우측 통계가 4열로 복귀");
  });
  assert.ok(html.includes(`${name} (01011111234)</div>`), "detail keeps the full name and suffix");
}
// 노드 원 안으로 연결선이 비쳐 보이지 않도록: 불투명 배경 원 및 선 단축(중앙 원 가장자리 시작, 노드 원/강조 링 가장자리 끝) 검증
{
  const people = Array.from({ length: 5 }, (_, i) => fake(i));
  const html = render(people);

  // 1) 각 노드 원 아래에 카드 배경색(#161b22)의 불투명 원이 반투명 색 원보다 먼저(아래에) 렌더링되어야 함
  const opaqueCircles = html.match(/<circle[^>]*fill="#161b22"[^>]*>/g) ?? [];
  assert.equal(opaqueCircles.length, 6, "중앙 원 1개 + 5개 노드 각각의 불투명 배경 원 5개 = 총 6개여야 함");

  // 각 노드 그룹 내에서 불투명 원이 반투명 원(fill-opacity / fillOpacity="0.25")보다 앞에 위치해야 함
  const nodeGroups = html.match(/<g class="cursor-pointer">[\s\S]*?<\/g>/g) ?? [];
  assert.equal(nodeGroups.length, 5, "노드 원 그룹 5개 존재");
  for (const group of nodeGroups) {
    const opaqueIdx = group.indexOf('fill="#161b22"');
    const transparentIdx = group.indexOf('fill-opacity="0.25"');
    assert.ok(opaqueIdx !== -1, "노드 그룹 내에 불투명 배경 원(#161b22)이 존재해야 함");
    assert.ok(transparentIdx !== -1, "노드 그룹 내에 반투명 색 원이 존재해야 함");
    assert.ok(opaqueIdx < transparentIdx, "불투명 배경 원이 반투명 원보다 먼저(아래에) 그려져야 함");
  }

  // 2) 선은 중앙 원 가장자리(r=22)에서 시작해 노드 원 가장자리에서 끝나야 함 (중심~끝점 거리 >= 노드 반지름)
  // 상위 3명(hot)은 강조 링(r+5) 기준
  const lines = html.match(/<line[^>]*>/g) ?? [];
  assert.equal(lines.length, 5, "노드 연결선 5개 존재");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const x1 = parseFloat(line.match(/x1="([^"]*)"/)![1]);
    const y1 = parseFloat(line.match(/y1="([^"]*)"/)![1]);
    const x2 = parseFloat(line.match(/x2="([^"]*)"/)![1]);
    const y2 = parseFloat(line.match(/y2="([^"]*)"/)![1]);

    const group = nodeGroups[i];
    const nodeCircleMatch = group.match(/<circle[^>]*cx="([^"]*)"[^>]*cy="([^"]*)"[^>]*r="([^"]*)"[^>]*fill-opacity="0.25"/);
    assert.ok(nodeCircleMatch, "노드 반투명 원 매치");
    const nodeCx = parseFloat(nodeCircleMatch[1]);
    const nodeCy = parseFloat(nodeCircleMatch[2]);
    const nodeR = parseFloat(nodeCircleMatch[3]);

    // 시작점: 중앙 원 가장자리 (거리 22)
    const distFromCenter = Math.hypot(x1 - PEOPLE_GRAPH.cx, y1 - PEOPLE_GRAPH.cy);
    assert.ok(Math.abs(distFromCenter - 22) < 0.2, `선 시작점은 중앙 원 가장자리(r=22)여야 함: actual=${distFromCenter}`);

    // 끝점: 노드 원 가장자리 (상위 3명은 r+5 강조 링 가장자리)
    const distToEnd = Math.hypot(x2 - nodeCx, y2 - nodeCy);
    assert.ok(distToEnd >= nodeR - 0.1, `선 끝점은 노드 원 밖이어야 함 (중심~끝점 거리 >= 반지름): actual=${distToEnd}, radius=${nodeR}`);

    const isHot = i < 3;
    const expectedDist = isHot ? nodeR + 5 : nodeR;
    assert.ok(Math.abs(distToEnd - expectedDist) < 0.2, `선 끝점은 노드/강조 링 가장자리여야 함: actual=${distToEnd}, expected=${expectedDist}`);
  }
}
console.log("people UI checks passed");
