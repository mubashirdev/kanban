import { expect, test } from "bun:test";
import { PublicAuth, SESSION_COOKIE } from "../src/server/public-auth";

const account = { username: "owner", password: "test-password-only" }, secret = "a".repeat(64);
const request = (cookie: string) => new Request("https://kanban.example.test/", { headers: { cookie } });
test("sessions persist across restarts, expire, and reject tampering or credential changes", () => {
  let now = Date.now();
  const auth = new PublicAuth(account, secret, () => now), cookie = auth.cookie();
  expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict; Max-Age=2592000");
  expect(auth.hasSession(request(cookie))).toBe(true);
  expect(new PublicAuth(account, secret).hasSession(request(cookie))).toBe(true);
  expect(auth.hasSession(request(cookie.split(";")[0] + "x"))).toBe(false);
  expect(new PublicAuth({ ...account, password: "changed" }, secret).hasSession(request(cookie))).toBe(false);
  expect(new PublicAuth(account, "b".repeat(64)).hasSession(request(cookie))).toBe(false);
  now += 30 * 24 * 3600 * 1000 + 1;
  expect(auth.hasSession(request(cookie))).toBe(false);
});
test("password sign-in limits failed attempts and sets no cookie for failures", async () => {
  let now = Date.now(); const auth = new PublicAuth(account, secret, () => now);
  const login = (password: string) => new Request("https://kanban.example.test/auth/login", { method: "POST", body: new URLSearchParams({ username: account.username, password }) });
  for (let i = 0; i < 10; i++) {
    const response = await auth.signIn(login("wrong"));
    expect(response.status).toBe(401); expect(response.headers.has("set-cookie")).toBe(false);
  }
  expect((await auth.signIn(login(account.password))).status).toBe(429);
  now += 61_000;
  const response = await auth.signIn(login(account.password));
  expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/auth/setup");
  expect(auth.hasSession(request(response.headers.get("set-cookie")!))).toBe(true);
  const headers = new Headers({ cookie: `${response.headers.get("set-cookie")!.split(";")[0]}; other=keep` });
  auth.stripCookie(headers); expect(headers.get("cookie")).toBe("other=keep");
});
