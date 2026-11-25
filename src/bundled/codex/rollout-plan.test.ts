import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { expect, it } from "vitest";
import { afterWindow, planRollout } from "./transcript";

type Known = NonNullable<Parameters<typeof planRollout>[0]>;
type File = Known["file"];
type Window = Exclude<Known["content"], string>;
type ReadPlan = Extract<ReturnType<typeof planRollout>, { kind: "read" }>;

const limit = 50 << 20;
const tailSize = 32 << 20;
const appendBytes = 512;
const oldest = "shown";
const shown = new Set([oldest]);
const file: File = { size: 8192, id: "file", modified: "version" };
const turnStart = (id: string) => ({
  type: "turn_context",
  payload: { turn_id: id },
});
const shownStart = turnStart(oldest);
const earlier = turnStart("earlier");
const script = {
  type: "response_item",
  payload: { type: "custom_tool_call", call_id: "script" },
};
const completion = {
  type: "event_msg",
  payload: { type: "item_completed", turn_id: "earlier" },
};

function planRead(known: Known | undefined, stat: File = file) {
  const plan = planRollout(known, oldest, stat);
  if (plan.kind !== "read")
    throw new Error(`Expected a read, got ${plan.kind}`);
  return plan;
}

it("reuses a complete cursor but reads from the last complete byte when data is trailing", () => {
  const content = { from: 0, bytes: file.size, lines: [shownStart] };
  const known = { oldest, file, content };
  expect(planRollout(known, oldest, file)).toEqual({ kind: "held", content });

  const bytes = file.size - 200;
  const partial = { ...known, content: { ...content, bytes } };
  const read = planRead(partial);
  expect(read.range).toEqual({
    from: bytes,
    start: bytes,
    end: file.size,
    align: false,
  });
  expect(read.held).toEqual(partial.content);
});

it.each(["oldest turn", "replacement", "shrink", "rewrite"] as const)(
  "discards held records and over-limit state after %s",
  (change) => {
    const changes = {
      "oldest turn": [file, "a different turn"],
      replacement: [{ ...file, id: "replacement" }, oldest],
      shrink: [{ ...file, size: file.size - 1 }, oldest],
      rewrite: [{ ...file, modified: "new version" }, oldest],
    } as const;
    const [stat, head] = changes[change];
    const window = { from: 0, bytes: file.size - 512, lines: [shownStart] };
    for (const content of [window, "over-limit"] as const) {
      expect(planRollout({ oldest, file, content }, head, stat)).toEqual({
        kind: "read",
        range: { from: 0, start: 0, end: stat.size, align: false },
        held: undefined,
      });
    }
  },
);

it("keeps the original window budget across appends and starts a fresh aligned read one byte over", () => {
  const from = 2048;
  const prior = { ...file, size: from + limit - 1 };
  const content = { from, bytes: prior.size, lines: [earlier, shownStart] };
  const known = { oldest, file: prior, content };
  const atLimit = planRead(known, { ...file, size: from + limit });
  expect(atLimit.held).toEqual(content);
  expect(atLimit.range).toEqual({
    from: prior.size,
    start: prior.size,
    end: from + limit,
    align: false,
  });
  const end = from + limit + 1;
  const fresh = planRead(known, { ...file, size: end });
  expect(fresh.held).toBeUndefined();
  expect(fresh.range).toEqual({
    from: end - tailSize,
    start: end - tailSize - 1,
    end,
    align: true,
  });
});

it("reads a fresh budget-sized file from zero and skips empty files", () => {
  expect(planRollout(undefined, oldest, { ...file, size: 0 })).toEqual({
    kind: "empty",
  });
  expect(planRead(undefined, { ...file, size: limit }).range).toEqual({
    from: 0,
    start: 0,
    end: limit,
    align: false,
  });
});

const cut = 4096;
const large = { ...file, size: limit + cut };
const firstRange = {
  from: large.size - tailSize,
  start: large.size - tailSize - 1,
  end: large.size,
  align: true,
};
const wideRange = { from: cut, start: cut - 1, end: large.size, align: true };

it("probes the limit before the initial cut and widens only when the cut is inside shown history", () => {
  const read = {
    lines: [completion],
    trailing: [shownStart],
    bytes: large.size - 512,
  };
  expect(afterWindow(firstRange, undefined, read, shown)).toMatchObject({
    kind: "probe",
    at: "limit",
    end: cut,
  });
  expect(
    afterWindow(firstRange, undefined, read, shown, {
      limit: true,
      cut: false,
    }),
  ).toEqual({
    kind: "limit",
    cache: "over-limit",
  });
  expect(
    afterWindow(firstRange, undefined, read, shown, { limit: false }),
  ).toMatchObject({
    kind: "probe",
    at: "cut",
    end: firstRange.from,
  });
  expect(
    afterWindow(firstRange, undefined, read, shown, {
      limit: false,
      cut: false,
    }),
  ).toMatchObject({
    kind: "accept",
    lines: [completion, shownStart],
  });
  const wider = afterWindow(firstRange, undefined, read, shown, {
    limit: false,
    cut: true,
  });
  expect(wider).toEqual({ kind: "widen", range: wideRange });
  if (wider.kind !== "widen") throw new Error("Expected the widened read");
  expect(
    afterWindow(wider.range, undefined, { ...read, lines: [earlier] }, shown),
  ).toEqual({
    kind: "accept",
    lines: [earlier, shownStart],
    cache: { from: cut, bytes: read.bytes, lines: [earlier] },
  });
});

it("widens without a cut probe when no record establishes ownership", () => {
  const read = { lines: [completion], trailing: [script], bytes: undefined };
  expect(afterWindow(firstRange, undefined, read, shown)).toMatchObject({
    kind: "probe",
    at: "limit",
  });
  expect(
    afterWindow(firstRange, undefined, read, shown, { limit: false }),
  ).toEqual({
    kind: "widen",
    range: wideRange,
  });
});

it("accepts a trailing earlier start without reading either prefix", () => {
  const read = { lines: [completion], trailing: [earlier], bytes: undefined };
  expect(afterWindow(firstRange, undefined, read, shown)).toEqual({
    kind: "accept",
    lines: [completion, earlier],
    cache: undefined,
  });
});

it("uses an earlier complete start before a later shown trailing start", () => {
  const bytes = large.size - 512;
  const read = { lines: [earlier], trailing: [shownStart], bytes };
  expect(afterWindow(firstRange, undefined, read, shown)).toEqual({
    kind: "accept",
    lines: [earlier, shownStart],
    cache: { from: firstRange.from, bytes, lines: [earlier] },
  });
});

it("joins retained and complete records for cache and shows the trailing records separately", () => {
  const held = { from: 10, bytes: 4096, lines: [shownStart] };
  const range = { from: 4096, start: 4096, end: 8192, align: false };
  const read = { lines: [script], trailing: [completion], bytes: 7680 };
  expect(afterWindow(range, held, read, shown)).toEqual({
    kind: "accept",
    lines: [shownStart, script, completion],
    cache: { from: 10, bytes: 7680, lines: [shownStart, script] },
  });
  expect(
    afterWindow(range, held, { ...read, bytes: undefined }, shown),
  ).toEqual({
    kind: "accept",
    lines: [shownStart, script, completion],
    cache: undefined,
  });
});

it.each([
  [1, true],
  [2, false],
] as const)(
  "applies the record cap with %s new complete records and a trailing record",
  (added, caches) => {
    const held = {
      from: 0,
      bytes: 4096,
      lines: Array(8191).fill(shownStart) as Window["lines"],
    };
    const range = { from: 4096, start: 4096, end: 8192, align: false };
    const read = {
      lines: Array(added).fill(script) as Window["lines"],
      trailing: [completion],
      bytes: 8191,
    };
    const result = afterWindow(range, held, read, shown);
    if (result.kind !== "accept")
      throw new Error(`Expected records, got ${result.kind}`);
    expect(result.lines).toHaveLength(8192 + added);
    expect(result.cache?.lines.length).toBe(caches ? 8192 : undefined);
  },
);

function appendTo(old: Known, bytes: number) {
  return {
    ...old,
    file: {
      ...old.file,
      size: old.file.size + bytes,
      modified: `${old.file.modified}+`,
    },
  };
}

const edit = {
  unchanged: (old: Known) => old,
  append: (old: Known) => appendTo(old, appendBytes),
  "larger append": (old: Known) => appendTo(old, 2 * appendBytes),
  shrink: (old: Known) => ({
    ...old,
    file: { ...old.file, size: old.file.size - appendBytes },
  }),
  replace: (old: Known) => ({
    ...old,
    file: { ...old.file, id: `${old.file.id}+` },
  }),
  rewrite: (old: Known) => ({
    ...old,
    file: { ...old.file, modified: `${old.file.modified}+` },
  }),
  "change oldest": (old: Known) => ({ ...old, oldest: `${old.oldest}+` }),
};
type Change = keyof typeof edit;
const changes = Object.keys(edit) as Change[];

const prefixEvidence: Partial<
  Record<
    Change,
    {
      shownStart: boolean;
      limit: boolean;
      cut?: boolean;
      outcome: "limit" | "accept" | "widen";
    }
  >
> = {
  shrink: { shownStart: true, limit: true, outcome: "limit" },
  replace: { shownStart: true, limit: false, cut: false, outcome: "accept" },
  rewrite: { shownStart: true, limit: false, cut: true, outcome: "widen" },
  "change oldest": { shownStart: false, limit: false, outcome: "widen" },
};

function finishRead(
  plan: ReadPlan,
  head: string,
  change: Change,
  from: number,
  path: string,
  record: (name: string) => void,
) {
  const { end } = plan.range;
  const evidence =
    !plan.held && end > limit ? prefixEvidence[change] : undefined;
  const read = {
    lines: [evidence ? completion : plan.held ? script : earlier],
    trailing: evidence?.shownStart ? [turnStart(head)] : [],
    bytes: end,
  };
  const turns = new Set([head]);
  let decision = afterWindow(plan.range, plan.held, read, turns);
  if (evidence) {
    if (decision.kind !== "probe")
      throw new Error(`${path}: must probe before deciding`);
    deepStrictEqual([decision.at, decision.end], ["limit", end - limit], path);
    const prefix = { limit: evidence.limit };
    decision = afterWindow(plan.range, plan.held, read, turns, prefix);
    if (evidence.cut !== undefined) {
      if (decision.kind !== "probe")
        throw new Error(`${path}: must probe the initial cut`);
      deepStrictEqual(
        [decision.at, decision.end],
        ["cut", plan.range.from],
        path,
      );
      decision = afterWindow(plan.range, plan.held, read, turns, {
        ...prefix,
        cut: evidence.cut,
      });
    }
    record(`prefix after ${change}: ${evidence.outcome}`);
  }
  strictEqual(decision.kind, evidence?.outcome ?? "accept", path);
  if (decision.kind === "limit") {
    deepStrictEqual(decision, { kind: "limit", cache: "over-limit" }, path);
    return { content: decision.cache, from };
  }
  if (decision.kind === "widen") {
    from = end - limit;
    deepStrictEqual(
      decision.range,
      { from, start: from - 1, end, align: true },
      path,
    );
    decision = afterWindow(
      decision.range,
      undefined,
      { ...read, lines: [turnStart(head)] },
      turns,
    );
  }
  if (decision.kind !== "accept" || !decision.cache)
    throw new Error(`${path}: expected cacheable records`);
  strictEqual(decision.cache.from, from, path);
  strictEqual(decision.cache.bytes, end, path);
  return { content: decision.cache, from };
}

it.each(["complete", "partial", "over-limit"] as const)(
  "checks every four-edit sequence with a %s cache",
  (seed) => {
    const from = 8192;
    const start = { ...file, size: from + limit - 2 * appendBytes };
    const content: Known["content"] =
      seed === "over-limit"
        ? seed
        : {
            from,
            bytes: start.size - (seed === "partial" ? 128 : 0),
            lines: [earlier, shownStart],
          };
    const witnesses = new Map<string, number>();
    const record = (name: string) =>
      witnesses.set(name, (witnesses.get(name) ?? 0) + 1);
    let leaves = 0;

    function visit(known: Known, originalCut: number, path: readonly Change[]) {
      if (path.length === 4) {
        leaves++;
        return;
      }
      for (const change of changes) {
        const next = edit[change](known);
        const trace = [...path, change];
        const message = trace.join(" → ");
        const plan = planRollout(known, next.oldest, next.file);
        const append = change === "append" || change === "larger append";
        const sameFileHistory = append || change === "unchanged";

        if (sameFileHistory && known.content === "over-limit") {
          deepStrictEqual(
            plan,
            { kind: "held", content: "over-limit" },
            message,
          );
          if (append) record("retains warning on append");
          visit(next, originalCut, trace);
          continue;
        }
        if (known.content === "over-limit")
          record(`invalidates warning after ${change}`);

        const inBudget = next.file.size <= originalCut + limit;
        const retained =
          sameFileHistory && inBudget && known.content !== "over-limit"
            ? known.content
            : undefined;
        if (retained && next.file.size === retained.bytes) {
          deepStrictEqual(plan, { kind: "held", content: retained }, message);
          visit(next, originalCut, trace);
          continue;
        }
        if (plan.kind !== "read")
          throw new Error(`${message}: expected read, got ${plan.kind}`);

        const cursor = retained?.bytes;
        deepStrictEqual(plan.held, retained, message);
        const newCut = next.file.size > limit ? next.file.size - tailSize : 0;
        strictEqual(plan.range.from, cursor ?? newCut, message);
        const expectedCut = cursor === undefined ? newCut : originalCut;
        const acquired = finishRead(
          plan,
          next.oldest,
          change,
          expectedCut,
          message,
          record,
        );
        if (append && retained) record("resumes append");
        if (append && !inBudget) record("crosses original span");
        visit({ ...next, content: acquired.content }, acquired.from, trace);
      }
    }

    visit({ oldest, file: start, content }, from, []);
    expect(leaves).toBe(2401);
    expect(witnesses.get("resumes append")).toBeGreaterThan(0);
    for (const change of changes) {
      const evidence = prefixEvidence[change];
      if (!evidence) continue;
      const witness = `prefix after ${change}: ${evidence.outcome}`;
      expect(witnesses.get(witness), witness).toBeGreaterThan(0);
    }
    if (seed === "over-limit") {
      expect(witnesses.get("retains warning on append")).toBeGreaterThan(0);
      for (const change of ["shrink", "replace", "rewrite", "change oldest"]) {
        expect(
          witnesses.get(`invalidates warning after ${change}`),
          change,
        ).toBeGreaterThan(0);
      }
    } else {
      expect(witnesses.get("crosses original span")).toBeGreaterThan(0);
    }
  },
);
