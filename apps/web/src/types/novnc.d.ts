declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string);

    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;

    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    disconnect(): void;
  }
}
