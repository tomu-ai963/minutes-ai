import { describe, it, expect, vi } from "vitest";
import {
  parseIp,
  isBlockedIp,
  assertPublicUrl,
  safeFetch,
  SsrfError,
} from "../src/lib/url-guard.js";

// テスト用の決定的リゾルバ（ホスト名 → IP 配列）を生成する。
function resolver(map) {
  return async (host) => map[host] || [];
}

describe("parseIp", () => {
  it("dotted decimal IPv4", () => {
    expect(parseIp("127.0.0.1")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
    expect(parseIp("8.8.8.8")).toEqual({ version: 4, bytes: [8, 8, 8, 8] });
  });

  it("normalizes obfuscated IPv4 (decimal / hex / octal / inet_aton)", () => {
    // 2130706433 = 127.0.0.1
    expect(parseIp("2130706433")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
    // 0x7f.0.0.1
    expect(parseIp("0x7f.0.0.1")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
    // octal 0177.0.0.1
    expect(parseIp("0177.0.0.1")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
    // two-part inet_aton 127.1 -> 127.0.0.1
    expect(parseIp("127.1")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
    // full hex 0x7f000001
    expect(parseIp("0x7f000001")).toEqual({ version: 4, bytes: [127, 0, 0, 1] });
  });

  it("parses IPv6 incl. compression and embedded IPv4", () => {
    expect(parseIp("::1").bytes.slice(15)).toEqual([1]);
    expect(parseIp("::ffff:127.0.0.1")).not.toBeNull();
    expect(parseIp("fe80::1")).not.toBeNull();
  });

  it("returns null for hostnames", () => {
    expect(parseIp("example.com")).toBeNull();
    expect(parseIp("hooks.slack.com")).toBeNull();
  });
});

describe("isBlockedIp", () => {
  const blocked = [
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254", // クラウドメタデータ
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1", // CGNAT
    "192.0.2.5", // TEST-NET-1
    "198.18.0.1",
    "224.0.0.1", // マルチキャスト
    "255.255.255.255",
  ];
  for (const ip of blocked) {
    it(`blocks ${ip}`, () => {
      expect(isBlockedIp(parseIp(ip))).toBe(true);
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.0.1", "172.32.0.1"];
  for (const ip of allowed) {
    it(`allows public ${ip}`, () => {
      expect(isBlockedIp(parseIp(ip))).toBe(false);
    });
  }

  it("blocks IPv6 loopback / link-local / unique-local / mapped-private", () => {
    expect(isBlockedIp(parseIp("::1"))).toBe(true);
    expect(isBlockedIp(parseIp("fe80::1"))).toBe(true);
    expect(isBlockedIp(parseIp("fc00::1"))).toBe(true);
    expect(isBlockedIp(parseIp("::ffff:10.0.0.1"))).toBe(true);
    expect(isBlockedIp(parseIp("::ffff:127.0.0.1"))).toBe(true);
  });

  it("allows a public IPv6", () => {
    expect(isBlockedIp(parseIp("2606:4700:4700::1111"))).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("gopher://x")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects credentials in URL", async () => {
    await expect(assertPublicUrl("https://user:pass@example.com")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects literal private/loopback IP hosts", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/webhook")).rejects.toBeInstanceOf(SsrfError);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      SsrfError
    );
    await expect(assertPublicUrl("http://2130706433/")).rejects.toBeInstanceOf(SsrfError); // obfuscated 127.0.0.1
    await expect(assertPublicUrl("http://localhost/x")).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects hostnames that resolve to private IPs", async () => {
    const resolve = resolver({ "evil.example.com": ["10.0.0.5"] });
    await expect(
      assertPublicUrl("https://evil.example.com/webhook", { resolve })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects hostnames that fail to resolve (fail-closed)", async () => {
    const resolve = resolver({});
    await expect(assertPublicUrl("https://nope.example.com", { resolve })).rejects.toBeInstanceOf(
      SsrfError
    );
  });

  it("accepts a public hostname", async () => {
    const resolve = resolver({ "hooks.slack.com": ["3.5.6.7"] });
    const u = await assertPublicUrl("https://hooks.slack.com/services/x", { resolve });
    expect(u.hostname).toBe("hooks.slack.com");
  });
});

describe("safeFetch", () => {
  it("blocks before making any network call for private hosts", async () => {
    const spy = vi.fn();
    globalThis.fetch = spy;
    await expect(safeFetch("http://127.0.0.1/x")).rejects.toBeInstanceOf(SsrfError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("re-validates redirect targets and rejects private redirects", async () => {
    const resolve = resolver({ "safe.example.com": ["8.8.8.8"], "internal.example.com": ["10.0.0.1"] });
    globalThis.fetch = vi.fn(async (u) => {
      // 最初の呼び出しで内部ホストへ 302 リダイレクトさせる
      return new Response(null, { status: 302, headers: { location: "https://internal.example.com/x" } });
    });
    await expect(
      safeFetch("https://safe.example.com/hook", {}, { resolve })
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("returns capped body on success", async () => {
    const resolve = resolver({ "safe.example.com": ["8.8.8.8"] });
    globalThis.fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const res = await safeFetch("https://safe.example.com/hook", {}, { resolve });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.text).toBe("ok");
  });

  it("rejects oversized responses via content-length", async () => {
    const resolve = resolver({ "safe.example.com": ["8.8.8.8"] });
    globalThis.fetch = vi.fn(
      async () => new Response("x", { status: 200, headers: { "content-length": "999999999" } })
    );
    await expect(
      safeFetch("https://safe.example.com/hook", {}, { resolve, maxBytes: 1024 })
    ).rejects.toBeInstanceOf(SsrfError);
  });
});
