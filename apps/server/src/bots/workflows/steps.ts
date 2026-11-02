/** Step keys: `<prefix>/<node>`, a map item as `<node>[i]`, and `/accept` or `/judge` under an agent step. */
const SUB_STEP = /\/(accept|judge)$/;

/** An agent step's accept command or judge turn, which belongs to that step. */
export const isSubStep = (step: string): boolean => SUB_STEP.test(step);

/** The node a step key runs; a sub-step names its agent step's node. */
export const nodeIdOfStep = (step: string): string =>
  (step.replace(SUB_STEP, "").split("/").at(-1) ?? step).replace(/\[\d+\]$/, "");
