import assert from "node:assert/strict";
import { branchLanes, laneGap, scrollTimelineToLeftOnSelect } from "../components/GitGraph/GitGraphPanel";

// UX2-2 1번 검수: 가로 스크롤 상태에서 커밋 선택 시 왼쪽 스크롤 복원 동작 검증
{
  let calledOptions: ScrollToOptions | null = null;
  const mockContainer = {
    scrollLeft: 120,
    scrollTo(options: ScrollToOptions) {
      calledOptions = options;
    },
  };

  // 1) 커밋 선택 시 scrollLeft > 0 이면 left: 0, smooth 스크롤 호출
  scrollTimelineToLeftOnSelect(mockContainer, true);
  assert.deepEqual(calledOptions, { left: 0, behavior: "smooth" }, "scrollLeft > 0에서 선택 시 left: 0 smooth 스크롤");

  // 2) scrollLeft === 0 이면 scrollTo 호출 안 함
  calledOptions = null;
  mockContainer.scrollLeft = 0;
  scrollTimelineToLeftOnSelect(mockContainer, true);
  assert.equal(calledOptions, null, "이미 scrollLeft === 0이면 scrollTo 호출하지 않음");

  // 3) 선택 해제(hasSelection = false) 시 scrollLeft > 0 이어도 scrollTo 호출 안 함
  calledOptions = null;
  mockContainer.scrollLeft = 120;
  scrollTimelineToLeftOnSelect(mockContainer, false);
  assert.equal(calledOptions, null, "선택 해제 시에는 스크롤을 건드리지 않음");

  // 4) container가 null이어도 안전하게 무시
  assert.doesNotThrow(() => {
    scrollTimelineToLeftOnSelect(null, true);
    scrollTimelineToLeftOnSelect(null, false);
  });
}

console.log("gitGraph checks passed");

// sparse branch ids (feature/etc = 493 on a real device) still get adjacent lanes
{
  const lane = branchLanes([1, 2, 3, 4, 5, 6, 493, 494]);
  assert.deepEqual([1, 2, 6, 493, 494].map(lane), [0, 1, 5, 6, 7]);
}

// only the branches in view get lanes; many lanes get narrower
{
  const lane = branchLanes([2, 4, 494, 4, 2]);
  assert.deepEqual([2, 4, 494].map(lane), [1, 2, 3]);
  assert.equal(laneGap(3), 24);
  assert.equal(laneGap(7), 16);
}
