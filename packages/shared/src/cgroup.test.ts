import { describe, expect, it } from "@effect/vitest";

import { type RootCgroup, cgroupDirectory, isCgroupWithin, pickRootCgroup } from "./cgroup.ts";

const SELF = "/user.slice/user-1000.slice/t3.service";

describe("isCgroupWithin", () => {
  it.each<[string, string, boolean]>([
    ["/a/b", "/a/b", true],
    ["/a/b/c", "/a/b", true],
    ["/a/bc", "/a/b", false],
    ["/a", "/a/b", false],
    ["/anything", "/", true],
    ["/", "/", true],
  ])("%s within %s → %s", (path, parent, expected) => {
    expect(isCgroupWithin(path, parent)).toBe(expected);
  });
});

describe("cgroupDirectory", () => {
  it.each([
    ["/", "/sys/fs/cgroup"],
    ["/system.slice/foo.service", "/sys/fs/cgroup/system.slice/foo.service"],
  ])("%s → %s", (path, expected) => {
    expect(cgroupDirectory(path)).toBe(expected);
  });
});

describe("pickRootCgroup", () => {
  const unit = "/user.slice/user-1000.slice/t3-agent-1.scope";
  const pidOwn = "/user.slice/user-1000.slice/other.scope";

  it.each<[string, Parameters<typeof pickRootCgroup>[0], RootCgroup]>([
    [
      "unit known → unit cgroup, whatever the pid reads",
      { unitCgroup: unit, pidCgroup: SELF, selfCgroup: SELF },
      { type: "adopted", cgroup: unit },
    ],
    [
      "unit known and pid unreadable → unit cgroup",
      { unitCgroup: unit, selfCgroup: SELF },
      { type: "adopted", cgroup: unit },
    ],
    [
      "no unit → the pid's own cgroup",
      { pidCgroup: pidOwn, selfCgroup: SELF },
      { type: "adopted", cgroup: pidOwn },
    ],
    [
      "same cgroup as the server → pid only, read again later",
      { pidCgroup: SELF, selfCgroup: SELF },
      { type: "pending" },
    ],
    [
      "a cgroup above the server's is never adopted",
      { pidCgroup: "/user.slice/user-1000.slice", selfCgroup: SELF },
      { type: "pending" },
    ],
    ["the root cgroup is never adopted", { pidCgroup: "/", selfCgroup: SELF }, { type: "pending" }],
    [
      "the root cgroup is never adopted with the server's unknown",
      { pidCgroup: "/", selfCgroup: undefined },
      { type: "pending" },
    ],
    [
      "a unit equal to the server's falls back to the pid",
      { unitCgroup: SELF, pidCgroup: pidOwn, selfCgroup: SELF },
      { type: "adopted", cgroup: pidOwn },
    ],
    [
      "a unit above the server's with the pid unreadable → none",
      { unitCgroup: "/user.slice", selfCgroup: SELF },
      { type: "none" },
    ],
    [
      "a cgroup below the server's is adopted",
      { pidCgroup: `${SELF}/child`, selfCgroup: SELF },
      { type: "adopted", cgroup: `${SELF}/child` },
    ],
    [
      "server cgroup unknown → the pid's own",
      { pidCgroup: pidOwn, selfCgroup: undefined },
      { type: "adopted", cgroup: pidOwn },
    ],
    ["nothing readable → none", { selfCgroup: SELF }, { type: "none" }],
  ])("%s", (_name, input, expected) => {
    expect(pickRootCgroup(input)).toEqual(expected);
  });
});
