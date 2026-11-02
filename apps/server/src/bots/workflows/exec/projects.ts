import type { Project } from "@t3tools/contracts";

/** The project a definition names: by title, or by the last segment of its root, ignoring case. */
export const projectByRef = (
  projects: ReadonlyArray<Project>,
  ref: string,
): Project | undefined => {
  const wanted = ref.trim().toLowerCase();
  return projects.find((project) => {
    if (project.archivedAt) return false;
    const base = project.workspaceRoot.replace(/\/+$/, "").split("/").at(-1)?.toLowerCase();
    return project.title.toLowerCase() === wanted || base === wanted;
  });
};
