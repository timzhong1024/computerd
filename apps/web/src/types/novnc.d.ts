declare module "@novnc/novnc/lib/rfb" {
  export default class RFB extends EventTarget {
    constructor(target: HTMLDivElement, url: string);

    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;

    disconnect(): void;
  }
}
