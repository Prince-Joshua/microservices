import { test } from "node:test";
import assert from "node:assert/strict";

import { RateLimiter } from "../middleware/rate-limit.js";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("allows `max` hits, then limits with a Retry-After", () => {
  const time = clock();
  const limiter = new RateLimiter({ windowMs: 60_000, max: 3, now: time.now });

  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.hit("a").limited, false);
  }

  const over = limiter.hit("a");
  assert.equal(over.limited, true);
  assert.equal(over.retryAfterSec, 60);

  time.advance(45_000);
  assert.equal(limiter.hit("a").retryAfterSec, 15);
});

test("the window ends and the key starts fresh", () => {
  const time = clock();
  const limiter = new RateLimiter({ windowMs: 60_000, max: 1, now: time.now });

  limiter.hit("a");
  assert.equal(limiter.hit("a").limited, true);

  time.advance(60_001);
  assert.equal(limiter.hit("a").limited, false);
});

test("keys are independent", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });

  limiter.hit("a");
  assert.equal(limiter.hit("a").limited, true);
  assert.equal(limiter.hit("b").limited, false);
});

test("check() doesn't count, and reports a key that has used up its allowance", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });

  assert.equal(limiter.check("a").limited, false);
  limiter.hit("a");
  assert.equal(limiter.check("a").limited, false);
  limiter.hit("a");
  assert.equal(limiter.check("a").limited, true);
  assert.equal(limiter.check("a").limited, true, "checking again changes nothing");
});

test("reset() clears a key", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 1 });

  limiter.hit("a");
  limiter.hit("a");
  limiter.reset("a");
  assert.equal(limiter.check("a").limited, false);
  assert.equal(limiter.hit("a").limited, false);
});

test("memory stays bounded when keys keep arriving", () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 1, maxKeys: 5 });

  for (let i = 0; i < 50; i++) {
    limiter.hit(`k${i}`);
  }

  // The newest key is still tracked; an old one was evicted.
  assert.equal(limiter.hit("k49").limited, true);
  assert.equal(limiter.hit("k0").limited, false);
});
