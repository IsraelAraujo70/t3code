import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/workflows/$environmentId")({
  component: Outlet,
});
