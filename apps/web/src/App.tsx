import { useState } from "react";
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { AppRouterProvider, createAppRouter } from "./router";

interface AppProps {
  history?: RouterHistory;
}

export function App({ history }: AppProps) {
  const [router] = useState(() =>
    createAppRouter(history ?? createMemoryHistory({ initialEntries: ["/"] })),
  );

  return <AppRouterProvider router={router} />;
}
