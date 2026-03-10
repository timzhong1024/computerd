import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

class ResizeObserverStub {
  observe() {}

  disconnect() {}

  unobserve() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

if (typeof HTMLMediaElement !== "undefined") {
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
}
