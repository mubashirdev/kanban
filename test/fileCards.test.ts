import { expect, test } from "bun:test";
import { filesByReply } from "../web/src/fileCards";

const e = (uuid: string, at: string, role: "user" | "assistant", kind = "text") => ({ uuid, at, role, kind, text: uuid });
const f = (name: string, updatedAt: string) => ({ name, size: 10, updatedAt });

test("output files go under the last reply of the turn they were written in", () => {
  const entries = [
    e("u1", "2026-10-06T10:00:00Z", "user"),
    e("a1", "2026-10-06T10:00:05Z", "assistant"),
    e("t1", "2026-10-06T10:00:06Z", "assistant", "tool"),
    e("a2", "2026-10-06T10:01:00Z", "assistant"),
    e("u2", "2026-10-06T11:00:00Z", "user"),
    e("a3", "2026-10-06T11:00:30Z", "assistant"),
  ];
  const cards = filesByReply(entries, [
    f("report.md", "2026-10-06T10:00:50Z"),
    f("b/data.csv", "2026-10-06T10:00:40Z"),
    f("later.md", "2026-10-06T11:00:20Z"),
    f("mockups/a-x.html", "2026-10-06T10:00:30Z"),
    f("old.md", "2026-10-05T10:00:00Z"),
  ]);
  expect(cards.get("a2")?.map((x) => x.name)).toEqual(["report.md", "b/data.csv"]);
  expect(cards.get("a3")?.map((x) => x.name)).toEqual(["later.md"]);
  expect(cards.has("a1")).toBe(false);
  expect([...cards.values()].flat().some((x) => x.name === "old.md" || x.name.startsWith("mockups/"))).toBe(false);
});

test("a turn without a reply yet gets no card", () => {
  const cards = filesByReply([e("a0", "2026-10-06T09:00:00Z", "assistant"), e("u1", "2026-10-06T10:00:00Z", "user")], [f("r.md", "2026-10-06T10:00:10Z")]);
  expect(cards.size).toBe(0);
});

test("huddle teammates' folders and huddles/ stay out of the chat; newest file first", () => {
  const entries = [e("u1", "2026-10-06T10:00:00Z", "user"), e("a1", "2026-10-06T10:00:05Z", "assistant")];
  const cards = filesByReply(entries, [
    f("qa-lead/shot.png", "2026-10-06T10:00:10Z"),
    f("ux-critic/notes.md", "2026-10-06T10:00:20Z"),
    f("huddles/h1/summary.md", "2026-10-06T10:00:30Z"),
    f("report.md", "2026-10-06T10:00:40Z"),
    f("data.csv", "2026-10-06T10:00:50Z"),
  ], ["qa-lead", "ux-critic"]);
  expect(cards.get("a1")?.map((x) => x.name)).toEqual(["data.csv", "report.md"]);
});
