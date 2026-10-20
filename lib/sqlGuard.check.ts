import assert from "node:assert/strict";
import { isPlainSelect } from "./sqlGuard";

assert.ok(isPlainSelect("SELECT * FROM commits WHERE id = ?"));
assert.ok(isPlainSelect("  \n select count(*) as n from commits"));
assert.ok(isPlainSelect("-- why\nSELECT 1"));
assert.ok(isPlainSelect("/* note */ SELECT 1"));
assert.ok(!isPlainSelect("/* comment */ DELETE FROM probe RETURNING id"), "comment-prefixed delete");
assert.ok(!isPlainSelect("-- x\nDELETE FROM probe"));
assert.ok(!isPlainSelect("WITH x AS (SELECT 1) DELETE FROM probe"));
assert.ok(!isPlainSelect("SELECT 1; DELETE FROM probe RETURNING id"), "RETURNING anywhere");
assert.ok(!isPlainSelect("PRAGMA foreign_keys = OFF"));
assert.ok(!isPlainSelect("UPDATE commits SET subject = 'x'"));
assert.ok(!isPlainSelect("/* unterminated DELETE FROM probe"));
assert.ok(!isPlainSelect("SELECT 1; DELETE FROM commits"), "second statement without RETURNING");
assert.ok(!isPlainSelect("SELECT 1;SELECT 2"));
assert.ok(isPlainSelect("SELECT 1;"), "a trailing semicolon is fine");
assert.ok(isPlainSelect("SELECT 1;  \n"));
console.log("sql guard checks passed");
