import assert from "node:assert/strict";
import test from "node:test";
import { FrozenPrepareCache, PrepareCapacityError, PREPARE_CACHE_MAX_BYTES, PREPARE_SNAPSHOT_MAX_BYTES } from "./frozen-prepare-cache.js";
test("frozen cache rejects 16MiB and 128MiB overflow without evicting retryable slots; staged rollback is invisible", () => {
  const cache=new FrozenPrepareCache(); const value="x".repeat(PREPARE_SNAPSHOT_MAX_BYTES-2);
  const staged=cache.stage("run","op",value); assert.equal(cache.bytes,0); staged();
  assert.throws(()=>cache.stage("too-big","op",value+"x"), error => error instanceof PrepareCapacityError && error.reason === "snapshot_too_large");
  for(let index=1;index<PREPARE_CACHE_MAX_BYTES/PREPARE_SNAPSHOT_MAX_BYTES;index++) cache.stage(`run-${index}`,"op",value)();
  assert.equal(cache.bytes,PREPARE_CACHE_MAX_BYTES);
  assert.throws(()=>cache.stage("overflow","op",{}), error => error instanceof PrepareCapacityError && error.reason === "cache_capacity");
  assert.equal(cache.get("run","op"),value);
  const replacement=cache.stage("run","new",{});assert.equal(cache.get("run","new"),null);replacement();
  assert.equal(cache.get("run","op"),null); assert.deepEqual(cache.get("run","new"),{});
  cache.clear();assert.equal(cache.bytes,0);
});
