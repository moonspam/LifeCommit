import type { Person } from "./people";

export const PEOPLE_GRAPH = { width: 380, height: 400, cx: 190, cy: 190, rings: [78, 118, 156] } as const;
type Label = { text: string; x: number; y: number; width: number; fontScale: number };
export type PeopleNode = { person: Person; x: number; y: number; radius: number; label: Label };
type RingLabel = { text: string; radius: number; x: number; y: number; width: number };

function formatNodeText(text: string, measure: (text: string) => number): { text: string; width: number; fontScale: number } {
  const maxText = PEOPLE_GRAPH.width - 28;
  const suffix = text.match(/ \([^)]*\)$/)?.[0] ?? "";
  const chars = Array.from(suffix ? text.slice(0, -suffix.length) : text);
  let visible = text;
  while (measure(visible) > maxText && chars.length) {
    chars.pop();
    visible = `${chars.join("")}${chars.length ? "…" : ""}${suffix}`;
  }
  const fontScale = Math.min(1, maxText / Math.max(measure(visible), 1));
  const width = 12 + measure(visible) * fontScale;
  return { text: visible, width, fontScale };
}

/** Measured text width comes from the caller's canvas using the same font as the SVG. */
export function placeNodeLabel(text: string, x: number, y: number, radius: number, measure: (text: string) => number): Label {
  const { text: visible, width, fontScale } = formatNodeText(text, measure);
  return { text: visible, width, fontScale,
    x: Math.max(8, Math.min(PEOPLE_GRAPH.width - 8 - width, x - width / 2)),
    y: Math.min(PEOPLE_GRAPH.height - 26, y + radius + 7) };
}

export function layoutPeopleGraph(people: Person[], labels: Map<string, { full: string; node: string }>,
  measure: (text: string) => number): { nodes: PeopleNode[]; rings: RingLabel[] } {
  const { cx, cy, rings, width: gw, height: gh } = PEOPLE_GRAPH;
  const maxScore = Math.max(...people.map((p) => p.score), 1e-9);
  const maxInteractions = Math.max(...people.map((p) => p.calls + p.sms + p.replies), 1);
  const ordered = [...people].sort((a, b) => (a.tag ?? "~").localeCompare(b.tag ?? "~") || b.score - a.score);

  const baseNodes = ordered.map((person, i) => {
    const angle = i / ordered.length * 2 * Math.PI - Math.PI / 2;
    const distance = rings[0] + (rings[2] - rings[0]) * Math.pow(1 - person.score / maxScore, 0.85);
    const x = cx + distance * Math.cos(angle), y = cy + distance * Math.sin(angle);
    const radius = 11 + 9 * Math.sqrt((person.calls + person.sms + person.replies) / maxInteractions);
    return { person, x, y, radius };
  });

  const center = { x: cx, y: cy, radius: 22 };
  const obstacles = [...baseNodes, center];
  const placedLabels: Label[] = [];
  const nodes: PeopleNode[] = [];

  for (const node of baseNodes) {
    const rawText = labels.get(node.person.key)?.node ?? node.person.name;
    const { text: visible, width, fontScale } = formatNodeText(rawText, measure);

    const candidates = [
      { x: Math.max(8, Math.min(gw - 8 - width, node.x - width / 2)), y: node.y + node.radius + 7 },
      { x: Math.max(8, Math.min(gw - 8 - width, node.x - width / 2)), y: node.y - node.radius - 7 - 18 },
      { x: node.x + node.radius + 7, y: Math.max(8, Math.min(gh - 8 - 18, node.y - 9)) },
      { x: node.x - node.radius - 7 - width, y: Math.max(8, Math.min(gh - 8 - 18, node.y - 9)) },
    ].map((c) => ({ x: Math.max(8, Math.min(gw - 8 - width, c.x)),
      y: Math.max(8, Math.min(gh - 8 - 18, c.y)) }));

    const clearOfCenter = (c: { x: number; y: number }) => {
      const dx = Math.max(c.x - cx, 0, cx - c.x - width);
      const dy = Math.max(c.y - cy, 0, cy - c.y - 18);
      return dx * dx + dy * dy >= (center.radius + 4) ** 2;
    };
    // A wide label can cross the center in every adjacent position. Move it beyond the center.
    if (!candidates.some(clearOfCenter)) candidates.push({ x: candidates[0].x,
      y: node.y < cy ? cy - center.radius - 4 - 18 : cy + center.radius + 4 });

    const inBounds = (c: { x: number; y: number }) =>
      c.x >= 8 && c.x + width <= gw - 8 && c.y >= 8 && c.y + 18 <= gh - 8;

    const clearOfNodes = (c: { x: number; y: number }) =>
      obstacles.every((n) => {
        const dx = Math.max(c.x - n.x, 0, n.x - (c.x + width));
        const dy = Math.max(c.y - n.y, 0, n.y - (c.y + 18));
        return dx * dx + dy * dy >= (n.radius + 4) ** 2;
      });

    const clearOfLabels = (c: { x: number; y: number }) =>
      placedLabels.every((l) =>
        c.x + width <= l.x || l.x + l.width <= c.x || c.y + 18 <= l.y || l.y + 18 <= c.y
      );

    let chosen: { x: number; y: number } | undefined = candidates.find(
      (c) => inBounds(c) && clearOfNodes(c) && clearOfLabels(c)
    );

    if (!chosen) {
      let bestPenalty = Infinity;
      chosen = candidates.find(clearOfCenter)!;
      for (const c of candidates) {
        if (!clearOfCenter(c)) continue;
        let penalty = 0;
        const outX = Math.max(0, 8 - c.x) + Math.max(0, c.x + width - (gw - 8));
        const outY = Math.max(0, 8 - c.y) + Math.max(0, c.y + 18 - (gh - 8));
        penalty += (outX + outY) * 1000;

        for (const n of obstacles) {
          const dx = Math.max(c.x - n.x, 0, n.x - (c.x + width));
          const dy = Math.max(c.y - n.y, 0, n.y - (c.y + 18));
          const distSq = dx * dx + dy * dy;
          const r = n.radius + 4;
          if (distSq < r * r) {
            penalty += (r - Math.sqrt(distSq));
          }
        }

        for (const l of placedLabels) {
          const ow = Math.max(0, Math.min(c.x + width, l.x + l.width) - Math.max(c.x, l.x));
          const oh = Math.max(0, Math.min(c.y + 18, l.y + 18) - Math.max(c.y, l.y));
          if (ow > 0 && oh > 0) {
            penalty += ow * oh;
          }
        }

        if (penalty < bestPenalty) {
          bestPenalty = penalty;
          chosen = c;
        }
      }
    }

    const label: Label = {
      text: visible,
      width,
      fontScale,
      x: Math.max(8, Math.min(gw - 8 - width, chosen.x)),
      y: Math.max(8, Math.min(gh - 8 - 18, chosen.y)),
    };
    placedLabels.push(label);
    nodes.push({ ...node, label });
  }

  const ringLabels: RingLabel[] = [];
  for (const [i, text] of ["자주", "가끔", "드물게"].entries()) {
    const width = measure(text), radius = rings[i];
    for (let j = 0; j < 24; j++) {
      const angle = -Math.PI / 2 + (j % 2 ? -1 : 1) * Math.ceil(j / 2) * Math.PI / 12;
      const x = cx + radius * Math.cos(angle) - width / 2, y = cy + radius * Math.sin(angle) - 6;
      if (x < 8 || x + width > PEOPLE_GRAPH.width - 8 || y < 8 || y + 12 > PEOPLE_GRAPH.height - 8) continue;
      const clear = nodes.every((node) => {
        const dx = Math.max(x - node.x, 0, node.x - (x + width));
        const dy = Math.max(y - node.y, 0, node.y - (y + 12));
        return dx * dx + dy * dy >= (node.radius + 4) ** 2;
      });
      if (clear && ringLabels.every((label) => x + width < label.x || label.x + label.width < x || y + 12 < label.y || label.y + 12 < y)) {
        ringLabels.push({ text, radius, x, y, width });
        break;
      }
    }
  }
  return { nodes, rings: ringLabels };
}
