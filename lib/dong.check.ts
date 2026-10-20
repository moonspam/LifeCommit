import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dongAt, parseDongs } from "./dong";

// the shipped (simplified) file; expected dongs taken from the original, unsimplified ver20260701 file
const dongs = parseDongs(JSON.parse(readFileSync("android/app/src/full/assets/public/dong.geojson", "utf8")));
assert.equal(dongs.length, 3558);
assert.equal(dongAt(dongs, 37.5663, 126.9779), "서울특별시 중구 명동"); // Seoul City Hall
assert.equal(dongAt(dongs, 35.1151, 129.0422), "부산광역시 동구 초량3동"); // Busan Station
assert.equal(dongAt(dongs, 37.6584, 126.8320), "경기도 고양시 덕양구 주교동"); // Goyang City Hall (시+구 split)
assert.equal(dongAt(dongs, 36.3325, 127.4342), "대전광역시 동구 중앙동"); // Daejeon Station
assert.equal(dongAt(dongs, 33.5104, 126.4914), "제주특별자치도 제주시 용담2동"); // Jeju Airport
assert.equal(dongAt(dongs, 37.0, 125.0), null); // Yellow Sea
console.log("dong checks passed");
