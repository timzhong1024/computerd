import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new TypeError("Expected #root element to exist");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
