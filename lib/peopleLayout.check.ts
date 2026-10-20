import assert from "node:assert/strict";
import { layoutPeopleGraph, placeNodeLabel } from "./peopleLayout";
import type { Person } from "./people";

const measure = (s: string) => Array.from(s).reduce((w, c) => w + (/[^\x00-\x7F]/.test(c) ? 10.5 : 6.5), 0);
const fake = (key: string, score: number, name = "Same"): Person => ({ key, name, tag: null, saved: true,
  calls: 1, callSec: 60, sms: 0, replies: 0, score, lastAt: 1_800_000_000_000, lastKind: "CALL" });

// The longest full-number suffix must remain visible even beside the left or right edge.
for (const x of [20, 360]) {
  const label = placeNodeLabel("Same (01011111234)", x, 190, 20, measure);
  assert.equal(label.text, "Same (01011111234)");
  assert.ok(label.x >= 8 && label.x + label.width <= 372, `label at ${x} stays in graph`);
  assert.ok(label.y >= 190 + 20 + 6, "label sits below its node");
}

// Long names may shorten, but a disambiguating phone suffix may not disappear.
{
  const label = placeNodeLabel("Very long contact name (01011111234)", 20, 190, 20, measure);
  assert.ok(label.text.endsWith("(01011111234)"));
  assert.ok(label.x >= 8 && label.x + label.width <= 372);
}

// Inner ring title must move off a top node; no ring title may intersect any node circle.
{
  const people = [fake("tel:01011111234", 10), fake("tel:02011111234", 7),
    ...Array.from({ length: 8 }, (_, i) => fake(`tel:0100000000${i}`, 6 - i * 0.5, `P${i}`))];
  const labels = new Map(people.map((p) => [p.key, { full: p.name, node: p.name }]));
  labels.get(people[0].key)!.node = "Same (01011111234)";
  labels.get(people[1].key)!.node = "Same (02011111234)";
  const { nodes, rings } = layoutPeopleGraph(people, labels, measure);
  assert.equal(nodes.length, 10);
  assert.equal(rings.length, 3, "all three rings find a free label position");
  for (const n of nodes) {
    assert.ok(n.label.x >= 8 && n.label.x + n.label.width <= 372, n.person.key);
    assert.ok(n.label.y >= 8 && n.label.y + 18 <= 392, n.person.key);
  }
  for (const ring of rings) {
    for (const node of nodes) {
      const dx = Math.max(ring.x - node.x, 0, node.x - (ring.x + ring.width));
      const dy = Math.max(ring.y - node.y, 0, node.y - (ring.y + 12));
      assert.ok(dx * dx + dy * dy >= (node.radius + 4) ** 2, `${ring.text} overlaps ${node.person.key}`);
    }
  }
}

// Labels must not overlap one another or any other node circle, staying within bounds.
{
  const people: Person[] = [
    { key: "tel:01022223333", name: "김서연 · 카카오톡", tag: null, saved: true,
      calls: 30, callSec: 1800, sms: 20, replies: 15, score: 10, lastAt: 1_800_000_000_000, lastKind: "REPLY" },
    { key: "tel:01011111234", name: "박준호", tag: null, saved: true,
      calls: 2, callSec: 120, sms: 1, replies: 0, score: 8, lastAt: 1_800_000_000_000, lastKind: "CALL" },
    ...Array.from({ length: 8 }, (_, i) => ({
      key: `tel:0100000000${i}`, name: i < 2 ? "이민수" : `동료${i}`, tag: null, saved: true,
      calls: 1, callSec: 60, sms: 0, replies: 0, score: 7 - i * 0.6, lastAt: 1_800_000_000_000, lastKind: "CALL" as const,
    })),
  ];
  const labels = new Map(people.map((p) => [p.key, { full: p.name, node: p.name }]));
  labels.get(people[2].key)!.node = "이민수 (01000000000)";
  labels.get(people[3].key)!.node = "이민수 (01000000001)";

  const { nodes } = layoutPeopleGraph(people, labels, measure);
  assert.equal(nodes.length, 10);

  for (const n of nodes) {
    assert.ok(n.label.x >= 8 && n.label.x + n.label.width <= 372, `${n.person.name} label stays in graph x`);
    assert.ok(n.label.y >= 8 && n.label.y + 18 <= 392, `${n.person.name} label stays in graph y`);
  }

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].label, b = nodes[j].label;
      const overlaps = !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + 18 <= b.y || b.y + 18 <= a.y);
      assert.ok(!overlaps, `label ${nodes[i].person.name} overlaps label ${nodes[j].person.name}`);
    }
  }

  for (const target of nodes) {
    for (const other of nodes) {
      if (target === other) continue;
      const dx = Math.max(target.label.x - other.x, 0, other.x - (target.label.x + target.label.width));
      const dy = Math.max(target.label.y - other.y, 0, other.y - (target.label.y + 18));
      assert.ok(dx * dx + dy * dy >= (other.radius + 4) ** 2,
        `label ${target.person.name} overlaps node circle ${other.person.name}`);
    }
  }
}
// Equal scores pack all fifteen contacts onto the inner ring; the center stays readable.
for (const name of ["연락처", "아주긴가짜연락처이름".repeat(8)]) {
  const people = Array.from({ length: 15 }, (_, i) => ({ ...fake(`fake:${i}`, 10, `${name}${i}`), calls: 10 }));
  const labels = new Map(people.map((p) => [p.key, { full: p.name, node: p.name }]));
  for (const { label, person } of layoutPeopleGraph(people, labels, measure).nodes) {
    const dx = Math.max(label.x - 190, 0, 190 - label.x - label.width);
    const dy = Math.max(label.y - 190, 0, 190 - label.y - 18);
    assert.ok(dx * dx + dy * dy >= 26 ** 2, `${person.name} obscures the center`);
    assert.ok(label.x >= 8 && label.x + label.width <= 372 && label.y >= 8 && label.y + 18 <= 392);
  }
}
console.log("people layout checks passed");

