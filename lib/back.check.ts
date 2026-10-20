import assert from "node:assert/strict";
import { pushBack, popBack } from "./back";

// 1. 스택 순서 (LIFO) 검증
{
  const order: string[] = [];
  const unregA = pushBack(() => { order.push("A"); });
  const unregB = pushBack(() => { order.push("B"); });
  const unregC = pushBack(() => { order.push("C"); });

  assert.equal(popBack(), true, "C가 pop 되어야 함");
  assert.deepEqual(order, ["C"]);

  assert.equal(popBack(), true, "B가 pop 되어야 함");
  assert.deepEqual(order, ["C", "B"]);

  assert.equal(popBack(), true, "A가 pop 되어야 함");
  assert.deepEqual(order, ["C", "B", "A"]);

  assert.equal(popBack(), false, "스택이 비었으므로 false 반환");
}

// 2. 해제(unreg) 후 pop 안 됨 검증
{
  const order: string[] = [];
  const unreg1 = pushBack(() => { order.push("1"); });
  const unreg2 = pushBack(() => { order.push("2"); });
  const unreg3 = pushBack(() => { order.push("3"); });

  // 중간의 2 해제
  unreg2();

  assert.equal(popBack(), true, "3이 pop 되어야 함");
  assert.deepEqual(order, ["3"]);

  assert.equal(popBack(), true, "2는 건너뛰고 1이 pop 되어야 함");
  assert.deepEqual(order, ["3", "1"]);

  assert.equal(popBack(), false, "더 이상 항목 없음");
}

// 3. 중복 해제(idempotent unregister) 안전 검증
{
  const order: string[] = [];
  const unregX = pushBack(() => { order.push("X"); });
  const unregY = pushBack(() => { order.push("Y"); });

  // unregX를 여러 번 호출해도 에러나 다른 항목(Y) 손상 없어야 함
  unregX();
  unregX();
  unregX();

  assert.equal(popBack(), true, "Y가 정상 pop 되어야 함");
  assert.deepEqual(order, ["Y"]);

  assert.equal(popBack(), false, "X는 이미 해제되었으므로 false");
}

console.log("back checks passed");

