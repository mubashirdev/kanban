import { expect, test } from "bun:test";
import { previewPortAllowed, previewTarget } from "../src/server/preview";

const blocked = [7777, 7778];

test("only user ports on this Mac, never the board's own", () => {
  expect(previewPortAllowed(5173, blocked)).toBe(true);
  for (const port of [7777, 7778, 80, 0, 70000, 5173.5, NaN]) expect(previewPortAllowed(port, blocked)).toBe(false);
});

test("screenshot targets must be localhost links or ports", () => {
  expect(previewTarget({ port: 5173 }, blocked)).toBe("http://localhost:5173/");
  expect(previewTarget({ port: "3000" }, blocked)).toBe("http://localhost:3000/");
  expect(previewTarget({ url: "localhost:5173/about?x=1" }, blocked)).toBe("http://localhost:5173/about?x=1");
  expect(previewTarget({ url: "http://127.0.0.1:8080/" }, blocked)).toBe("http://127.0.0.1:8080/");
  for (const url of ["https://example.com", "http://192.168.1.5:5173", "http://localhost.evil.com:5173", "http://user@localhost:5173", "file:///etc/passwd", "http://[::2]:5173"]) {
    expect(() => previewTarget({ url }, blocked)).toThrow();
  }
  expect(() => previewTarget({ port: 7777 }, blocked)).toThrow("can't be opened");
  expect(() => previewTarget({ url: "http://localhost:7777/api" }, blocked)).toThrow("can't be opened");
  expect(() => previewTarget({ url: "http://localhost/" }, blocked)).toThrow("can't be opened");
  expect(() => previewTarget({ port: "abc" }, blocked)).toThrow();
  expect(() => previewTarget({}, blocked)).toThrow("Give a port or a link");
});

test("take_screenshot from a run saves to the run's own ticket", async () => {
  const { callTool } = await import("../src/mcp-server");
  const calls: unknown[] = [];
  const client = {
    listProfiles: async () => [{ slug: "p", name: "P", path: "/repo" }],
    screenshot: async (...args: unknown[]) => { calls.push(args); return { files: ["screenshots/5173-phone-x.png", "screenshots/5173-desktop-x.png"] }; },
  };
  const r = await callTool("take_screenshot", { port: 5173 }, { client, cwd: "/repo", env: { CKANBAN_TICKET: "p/t_1" } } as any);
  expect(calls).toEqual([["p", "t_1", { port: 5173, url: undefined }]]);
  expect(r.content[0].text).toContain("screenshots/5173-phone-x.png");
});
