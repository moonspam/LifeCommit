import {
  SHARE_CHUNK_SIZE,
  isValidShareMediaId,
  makeReplayVideoFilename,
  selectSupportedVideoMimeType,
  calcExpectedVideoDurationSec,
  makeEvenDimension,
  chunkBinary,
  uint8ArrayToBase64,
} from "./replayVideo";

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

console.log("=== [1] selectSupportedVideoMimeType 순수 함수 검증 ===");
{
  // 1. 둘 다 지원하는 경우 -> codecs=avc1 우선
  const mime1 = selectSupportedVideoMimeType((m) =>
    m === "video/mp4;codecs=avc1" || m === "video/mp4" || m === "video/webm"
  );
  assert(mime1 === "video/mp4;codecs=avc1", `expected video/mp4;codecs=avc1, got ${mime1}`);

  // 2. video/mp4 만 지원하는 경우
  const mime2 = selectSupportedVideoMimeType((m) => m === "video/mp4");
  assert(mime2 === "video/mp4", `expected video/mp4, got ${mime2}`);

  // 3. webm만 지원하는 경우 -> null (webm 저장 안 함)
  const mime3 = selectSupportedVideoMimeType((m) => m === "video/webm");
  assert(mime3 === null, `expected null for webm only, got ${mime3}`);

  // 4. 지원하는 형식이 전혀 없는 경우 -> null
  const mime4 = selectSupportedVideoMimeType(() => false);
  assert(mime4 === null, `expected null when unsupported, got ${mime4}`);

  // 5. check 함수 미제공 시 (Node 환경에서는 MediaRecorder 없으므로 null)
  const mime5 = selectSupportedVideoMimeType();
  assert(mime5 === null, `expected null when no MediaRecorder in Node env`);
}

console.log("=== [2] calcExpectedVideoDurationSec 순수 함수 검증 ===");
{
  // 1. 기본 1배속: 44초 -> 44/1 + 1 = 45초
  assert(calcExpectedVideoDurationSec(44, 1) === 45, "expected 45s for 44s at 1x");

  // 2. 2배속: 44초 -> ceil(44/2) + 1 = 22 + 1 = 23초
  assert(calcExpectedVideoDurationSec(44, 2) === 23, "expected 23s for 44s at 2x");

  // 3. 4배속: 44초 -> ceil(44/4) + 1 = 11 + 1 = 12초
  assert(calcExpectedVideoDurationSec(44, 4) === 12, "expected 12s for 44s at 4x");

  // 4. 소수점 올림 확인: 10.2초 -> ceil(10.2) + 1 = 11 + 1 = 12초
  assert(calcExpectedVideoDurationSec(10.2, 1) === 12, "expected 12s for 10.2s at 1x");

  // 5. 0초 재생 -> 0 + 1 = 1초 (끝 화면 1초)
  assert(calcExpectedVideoDurationSec(0, 1) === 1, "expected 1s for 0s play");

  // 6. speed <= 0 예외 처리
  assert(calcExpectedVideoDurationSec(44, 0) === 0, "expected 0 for 0 speed");
}

console.log("=== [3] makeReplayVideoFilename 순수 함수 검증 ===");
{
  // 1. 단일 날짜 문자열
  assert(
    makeReplayVideoFilename("2026-10-21") === "lifecommit_replay_2026-10-21.mp4",
    "single string filename check"
  );

  // 2. 단일 날짜 객체
  assert(
    makeReplayVideoFilename({ start: "2026-10-21" }) === "lifecommit_replay_2026-10-21.mp4",
    "single object filename check"
  );

  // 3. start와 end가 같은 객체
  assert(
    makeReplayVideoFilename({ start: "2026-10-21", end: "2026-10-21" }) ===
      "lifecommit_replay_2026-10-21.mp4",
    "same start/end filename check"
  );

  // 4. 기간 객체
  assert(
    makeReplayVideoFilename({ start: "2026-10-01", end: "2026-10-21" }) ===
      "lifecommit_replay_2026-10-01_2026-10-21.mp4",
    "range filename check"
  );
}

console.log("=== [4] isValidShareMediaId 순수 함수 검증 ===");
{
  // 1. 정상 id
  assert(isValidShareMediaId("rec_1729000000_a1b2c3d4"), "valid format");
  assert(isValidShareMediaId("abc-123_XYZ"), "valid hyphen, underscore, mixed case");
  assert(isValidShareMediaId("a".repeat(64)), "valid max length 64");
  assert(isValidShareMediaId("x"), "valid min length 1");

  // 2. 비정상 id
  assert(!isValidShareMediaId(""), "empty id rejected");
  assert(!isValidShareMediaId("a".repeat(65)), "over 64 length rejected");
  assert(!isValidShareMediaId("../etc"), "path traversal rejected");
  assert(!isValidShareMediaId("foo/bar"), "slash rejected");
  assert(!isValidShareMediaId("foo\\bar"), "backslash rejected");
  assert(!isValidShareMediaId("id with space"), "space rejected");
  assert(!isValidShareMediaId("id.with.dot"), "dot rejected");
  assert(!isValidShareMediaId("id@special"), "special chars rejected");
}

console.log("=== [5] makeEvenDimension 순수 함수 검증 ===");
{
  assert(makeEvenDimension(100) === 100, "100 -> 100");
  assert(makeEvenDimension(101) === 100, "101 -> 100");
  assert(makeEvenDimension(360) === 360, "360 -> 360");
  assert(makeEvenDimension(359) === 358, "359 -> 358");
  assert(makeEvenDimension(1) === 2, "1 -> 2 (min 2)");
  assert(makeEvenDimension(0) === 2, "0 -> 2 (min 2)");
}

console.log("=== [6] chunkBinary 순수 함수 검증 ===");
{
  // 1. 0바이트 -> 빈 배열
  const empty = new Uint8Array(0);
  const emptyChunks = chunkBinary(empty, 512 * 1024);
  assert(emptyChunks.length === 0, "0 bytes returns empty array");

  // 2. 512KB 미만 (100바이트) -> 1개 조각
  const small = new Uint8Array(100);
  small.fill(42);
  const smallChunks = chunkBinary(small, 512 * 1024);
  assert(smallChunks.length === 1, "small buffer returns 1 chunk");
  assert(smallChunks[0].length === 100, "small chunk has exact size");
  assert(smallChunks[0][0] === 42, "small chunk retains content");

  // 3. 512KB 정확히 일치 -> 1개 조각
  const exact = new Uint8Array(512 * 1024);
  const exactChunks = chunkBinary(exact, 512 * 1024);
  assert(exactChunks.length === 1, "exact 512KB returns 1 chunk");
  assert(exactChunks[0].length === 512 * 1024, "exact chunk size");

  // 4. 512KB + 100바이트 -> 2개 조각 (마지막 조각 100바이트)
  const over = new Uint8Array(512 * 1024 + 100);
  over[0] = 1;
  over[512 * 1024] = 2;
  const overChunks = chunkBinary(over, 512 * 1024);
  assert(overChunks.length === 2, "512KB + 100 bytes returns 2 chunks");
  assert(overChunks[0].length === 512 * 1024, "first chunk is 512KB");
  assert(overChunks[1].length === 100, "second chunk is 100 bytes");
  assert(overChunks[0][0] === 1, "first chunk data matches");
  assert(overChunks[1][0] === 2, "second chunk data matches");

  // 5. 1024KB -> 2개 조각
  const doubleExact = new Uint8Array(1024 * 1024);
  const doubleChunks = chunkBinary(doubleExact, 512 * 1024);
  assert(doubleChunks.length === 2, "1024KB returns 2 chunks");
  assert(doubleChunks[0].length === 512 * 1024, "first chunk 512KB");
  assert(doubleChunks[1].length === 512 * 1024, "second chunk 512KB");
}

console.log("=== [7] uint8ArrayToBase64 검증 ===");
{
  const text = "Hello World! LifeCommit Replay Video";
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const base64 = uint8ArrayToBase64(bytes);
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  assert(decoded === text, `base64 roundtrip matches: ${decoded}`);
}

console.log("✓ All replayVideo check assertions passed!");
