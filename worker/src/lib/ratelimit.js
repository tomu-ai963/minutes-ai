/**
 * ratelimit.js — スライディングウィンドウ方式のレート制限
 *
 * 設計方針（ap-invoice / deflect の `lib/ratelimit.ts` を JS 版として踏襲）:
 *   - Durable Object（`RATE_LIMITER` バインド）が利用可能ならそれを使い、
 *     未バインド時は同一 isolate 内のメモリ Map にフォールバックする。
 *   - キーごとに直近ウィンドウ内のヒットタイムスタンプを保持し、上限超過を判定する。
 *   - テナント（API キーのハッシュ）単位・IP 単位の複数バケットを個別に評価する。
 *
 * 注意: メモリ版は isolate ローカルのためベストエフォート（複数 isolate 間で共有されない）。
 *       本番の厳密なグローバル制限には Durable Object バインドを推奨。
 */

/**
 * 直近ウィンドウのタイムスタンプ配列から判定する純粋関数。
 * @param {number[]} timestamps 既存のヒット時刻（ms）
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 * @returns {{ allowed: boolean, retryAfter: number, remaining: number, timestamps: number[] }}
 */
export function slidingWindow(timestamps, limit, windowMs, now) {
  const cutoff = now - windowMs;
  const recent = timestamps.filter((t) => t > cutoff);
  if (recent.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    return { allowed: false, retryAfter, remaining: 0, timestamps: recent };
  }
  recent.push(now);
  return { allowed: true, retryAfter: 0, remaining: limit - recent.length, timestamps: recent };
}

/* ----------------------------- メモリ版フォールバック ----------------------------- */

/** @type {Map<string, number[]>} */
const memStore = new Map();

/**
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 */
function memoryCheck(key, limit, windowMs, now) {
  const res = slidingWindow(memStore.get(key) || [], limit, windowMs, now);
  memStore.set(key, res.timestamps);
  return { allowed: res.allowed, retryAfter: res.retryAfter, remaining: res.remaining };
}

// テスト用: メモリ状態をリセットする。
export function _resetMemoryStore() {
  memStore.clear();
}

/* ----------------------------- Durable Object ----------------------------- */

/**
 * レート制限用 Durable Object。キー名で idFromName して 1 キー = 1 インスタンス。
 * wrangler.toml で以下のようにバインドする（任意。未設定ならメモリ版が使われる）:
 *   [[durable_objects.bindings]]
 *   name = "RATE_LIMITER"
 *   class_name = "RateLimiter"
 */
export class RateLimiter {
  /** @param {any} state @param {any} env */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /** @param {Request} request */
  async fetch(request) {
    const { limit, windowMs, now } = await request.json();
    const stored = (await this.state.storage.get("ts")) || [];
    const res = slidingWindow(stored, limit, windowMs, now);
    await this.state.storage.put("ts", res.timestamps);
    return new Response(
      JSON.stringify({ allowed: res.allowed, retryAfter: res.retryAfter, remaining: res.remaining }),
      { headers: { "content-type": "application/json" } }
    );
  }
}

/**
 * @param {any} env
 * @param {string} key
 * @param {number} limit
 * @param {number} windowMs
 * @param {number} now
 */
async function checkOne(env, key, limit, windowMs, now) {
  if (env && env.RATE_LIMITER) {
    try {
      const id = env.RATE_LIMITER.idFromName(key);
      const stub = env.RATE_LIMITER.get(id);
      const resp = await stub.fetch("https://rate-limiter.internal/", {
        method: "POST",
        body: JSON.stringify({ limit, windowMs, now }),
      });
      return await resp.json();
    } catch {
      // DO 呼び出し失敗時はメモリ版へフォールバック（fail-open にはしない）
      return memoryCheck(key, limit, windowMs, now);
    }
  }
  return memoryCheck(key, limit, windowMs, now);
}

/**
 * 複数バケットを評価し、いずれかが上限超過なら拒否する。
 * @param {any} env
 * @param {Array<{ key: string, limit: number, windowMs: number }>} buckets
 * @param {number} [now]
 * @returns {Promise<{ allowed: boolean, retryAfter?: number }>}
 */
export async function enforceRateLimit(env, buckets, now = Date.now()) {
  let maxRetryAfter = 0;
  let blocked = false;
  for (const b of buckets) {
    const res = await checkOne(env, b.key, b.limit, b.windowMs, now);
    if (!res.allowed) {
      blocked = true;
      maxRetryAfter = Math.max(maxRetryAfter, res.retryAfter || 0);
    }
  }
  if (blocked) return { allowed: false, retryAfter: maxRetryAfter || 60 };
  return { allowed: true };
}
