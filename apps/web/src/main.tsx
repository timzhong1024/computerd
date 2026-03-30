import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserHistory } from "@tanstack/react-router";
import { App } from "./App";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new TypeError("Expected #root element to exist");
}

createRoot(rootElement).render(
  <StrictMode>
    <App history={createBrowserHistory()} />
  </StrictMode>,
);
