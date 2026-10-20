import assert from "node:assert/strict";
import { displayHash } from "./commitHash";

assert.equal(displayHash("abcdef1234"), "abcdef1");
assert.equal(displayHash(""), "0000000");
const a = displayHash("us:com.android.chrome:1790000000000");
assert.match(a, /^[0-9a-f]{7}$/);
assert.equal(a, displayHash("us:com.android.chrome:1790000000000"));
assert.notEqual(a, displayHash("us:com.android.chrome:1790000001000"));
assert.notEqual(displayHash("commit_m_1790000000000_ab12"), displayHash("commit_m_1790000001000_cd34"));
assert.match(displayHash("commit_m_1790000000000_ab12"), /^[0-9a-f]{7}$/);
console.log("commit hash checks passed");
