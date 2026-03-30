import type { RouterHistory } from "@tanstack/react-router";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { ConsolePage } from "./ui/ConsolePage";
import { HomePage } from "./ui/HomePage";
import { MonitorPage } from "./ui/MonitorPage";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage,
});

const monitorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/computers/$name/monitor",
  component: MonitorRouteComponent,
});

const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/computers/$name/console",
  component: ConsoleRouteComponent,
});

const execRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/computers/$name/exec",
  component: ExecRouteComponent,
});

const routeTree = rootRoute.addChildren([homeRoute, monitorRoute, consoleRoute, execRoute]);

export function createAppRouter(history: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: "intent",
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

export function AppRouterProvider({ router }: { router: AppRouter }) {
  return <RouterProvider router={router} />;
}

function MonitorRouteComponent() {
  const { name } = monitorRoute.useParams();
  return <MonitorPage computerName={name} />;
}

function ConsoleRouteComponent() {
  const { name } = consoleRoute.useParams();
  return <ConsolePage computerName={name} mode="console" />;
}

function ExecRouteComponent() {
  const { name } = execRoute.useParams();
  return <ConsolePage computerName={name} mode="exec" />;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
