import { describe, expect, it } from "vite-plus/test";

import { threadReturnTab } from "./threadReturnTab";

describe("threadReturnTab", () => {
  it("returns to the Kanban tab only when the thread route was opened from it", () => {
    expect(threadReturnTab({ environmentId: "e", threadId: "t", returnTab: "kanban" })).toBe(
      "kanban",
    );
    expect(threadReturnTab({ environmentId: "e", threadId: "t" })).toBe("threads");
    expect(threadReturnTab({ returnTab: "usage" })).toBe("threads");
    expect(threadReturnTab(undefined)).toBe("threads");
  });
});
