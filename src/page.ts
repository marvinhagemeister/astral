import { deadline } from "https://deno.land/std@0.198.0/async/deadline.ts";

import { Celestial, Network_Cookie } from "../bindings/celestial.ts";
import { Browser } from "./browser.ts";
import { ElementHandle } from "./elementHandle.ts";
import { BASE_URL, convertToUint8Array, retryDeadline } from "./util.ts";
import { Mouse } from "./mouse.ts";
import { Keyboard } from "./keyboard.ts";
import { Touchscreen } from "./touchscreen.ts";
import { Dialog } from "./dialog.ts";

export type DeleteCookieOptions = Omit<
  Parameters<Celestial["Network"]["deleteCookies"]>[0],
  "transferMode"
>;

export type GoToOptions = WaitForOptions & {
  referrer?: string;
};

export type PdfOptions = Omit<
  Parameters<Celestial["Page"]["printToPDF"]>[0],
  "transferMode"
>;

export type ScreenshotOptions = Parameters<
  Celestial["Page"]["captureScreenshot"]
>[0];

export type Cookie = Network_Cookie;

export type WaitForOptions = {
  waitUntil?: "load" | "networkidle0" | "networkidle2";
};

export type WaitForNetworkIdleOptions = {
  idleTime?: number;
  idleConnections?: number;
};

type AnyArray = readonly unknown[];

export type EvaluateFunction<T, R extends AnyArray> =
  | string
  | ((...args: R) => T);

export interface EvaluateOptions<T> {
  args: Readonly<T>;
}

export interface PageEventMap {
  "dialog": DialogEvent;
}

export class DialogEvent extends CustomEvent<Dialog> {
  constructor(detail: Dialog) {
    super("dialog", { detail });
  }
}

/**
 * Page provides methods to interact with a single tab in the browser
 */
export class Page extends EventTarget {
  #id: string;
  #celestial: Celestial;
  #browser: Browser;
  #url: string | undefined;

  readonly timeout = 10000;
  readonly mouse: Mouse;
  readonly keyboard: Keyboard;
  readonly touchscreen: Touchscreen;

  constructor(
    id: string,
    url: string | undefined,
    ws: WebSocket,
    browser: Browser,
  ) {
    super();

    this.#id = id;
    this.#url = url;
    this.#celestial = new Celestial(ws);
    this.#browser = browser;

    this.#celestial.addEventListener("Page.frameNavigated", (e) => {
      const { frame } = e.detail;
      this.#url = frame.urlFragment ?? frame.url;
    });

    this.#celestial.addEventListener("Page.javascriptDialogOpening", (e) => {
      this.dispatchEvent(
        new DialogEvent(new Dialog(this.#celestial, e.detail)),
      );
    });

    this.mouse = new Mouse(this.#celestial);
    this.keyboard = new Keyboard(this.#celestial);
    this.touchscreen = new Touchscreen(this.#celestial);
  }

  async #getRoot() {
    const doc = await retryDeadline(
      (async () => {
        while (true) {
          const root = await this.#celestial.DOM.getDocument({
            depth: 0,
          });
          if (root) return root;
        }
      })(),
      this.timeout,
    );
    return new ElementHandle(doc.root.nodeId, this.#celestial, this);
  }

  // @ts-ignore see below
  addEventListener<K extends keyof PageEventMap>(
    type: K,
    listener: (event: PageEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void {
    // @ts-ignore TODO(lino-levan): Investigate why this is wrong
    super.addEventListener(type, listener, options);
  }

  /**
   * Returns raw celestial bindings for the page. Super unsafe unless you know what you're doing.
   */
  unsafelyGetCelestialBindings() {
    return this.#celestial;
  }

  /**
   * Runs `document.querySelector` within the page. If no element matches the selector, the return value resolves to `null`.
   *
   * @example
   * ```ts
   * const elementWithClass = await page.$(".class");
   * ```
   */
  async $(selector: string) {
    const root = await this.#getRoot();
    return root.$(selector);
  }

  /**
   * The method runs `document.querySelectorAll` within the page. If no elements match the selector, the return value resolves to `[]`.
   *
   * @example
   * ```ts
   * const elementsWithClass = await page.$$(".class");
   * ```
   */
  async $$(selector: string) {
    const root = await this.#getRoot();
    return retryDeadline(root.$$(selector), this.timeout);
  }

  /**
   * Brings page to front (activates tab).
   *
   * @example
   * ```ts
   * await page.bringToFront();
   * ```
   */
  async bringToFront() {
    await retryDeadline(this.#celestial.Page.bringToFront(), this.timeout);
  }

  /**
   * Get the browser the page belongs to.
   */
  browser() {
    return this.#browser;
  }

  /**
   * Close this page in the browser
   */
  async close() {
    const req = await fetch(`${BASE_URL}/json/close/${this.#id}`);
    const res = await req.text();

    if (res === "Target is closing") {
      const index = this.#browser.pages.indexOf(this);
      if (index > -1) {
        this.#browser.pages.splice(index, 1);
      }
      return;
    }

    this.#celestial.close();

    throw new Error(`Page has already been closed or doesn't exist (${res})`);
  }

  /**
   * The full HTML contents of the page, including the DOCTYPE.
   */
  async content(): Promise<string> {
    // https://stackoverflow.com/questions/6088972/get-doctype-of-an-html-as-string-with-javascript
    const { result } = await retryDeadline(
      this.#celestial.Runtime.evaluate({
        expression:
          `"<!DOCTYPE " + document.doctype.name + (document.doctype.publicId ? ' PUBLIC "' + document.doctype.publicId + '"' : '') + (!document.doctype.publicId && document.doctype.systemId ? ' SYSTEM' : '') + (document.doctype.systemId ? ' "' + document.doctype.systemId + '"' : '') + '>\\n' + document.documentElement.outerHTML`,
      }),
      this.timeout,
    );

    return result.value;
  }

  /**
   * If no URLs are specified, this method returns cookies for the current page URL. If URLs are specified, only cookies for those URLs are returned.
   */
  async cookies(...urls: string[]): Promise<Cookie[]> {
    const result = await retryDeadline(
      this.#celestial.Network.getCookies({ urls }),
      this.timeout,
    );
    return result.cookies;
  }

  /**
   * Deletes browser cookies with matching name and url or domain/path pair.
   */
  async deleteCookies(cookieDescription: DeleteCookieOptions) {
    await retryDeadline(
      this.#celestial.Network.deleteCookies(cookieDescription),
      this.timeout,
    );
  }

  // TODO: `Page.emulate` based on https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/common/Device.ts

  /**
   * Enables CPU throttling to emulate slow CPUs.
   */
  async emulateCPUThrottling(factor: number) {
    await retryDeadline(
      this.#celestial.Emulation.setCPUThrottlingRate({ rate: factor }),
      this.timeout,
    );
  }

  /**
   * Runs a function in the context of the page
   *
   * @example
   * ```ts
   * /// <reference lib="dom" />
   * const innerHTML = await page.evaluate(()=>document.body.innerHTML)
   * ```
   */
  async evaluate<T, R extends AnyArray>(
    func: EvaluateFunction<T, R>,
    evaluateOptions?: EvaluateOptions<R>,
  ) {
    if (typeof func === "function") {
      const args = evaluateOptions?.args ?? [];
      func = `(${func.toString()})(${
        args.map((arg) => `${JSON.stringify(arg)}`).join(",")
      })`;
    }
    const { result, exceptionDetails } = await retryDeadline(
      this.#celestial.Runtime.evaluate({
        expression: func,
        awaitPromise: true,
        returnByValue: true,
      }),
      this.timeout,
    );

    if (exceptionDetails) {
      throw exceptionDetails;
    }

    if (result.type === "bigint") {
      return BigInt(result.unserializableValue!.slice(0, -1));
    } else if (result.type === "undefined") {
      return undefined;
    } else if (result.type === "object") {
      if (result.subtype === "null") {
        return null;
      }
    }

    return result.value;
  }

  /**
   * This method navigate to the previous page in history.
   */
  // async goBack(options?: GoToOptions) {
  //   await this.waitForNavigation(options)
  // }

  /**
   * This method navigate to the next page in history.
   */
  // async goForward(options?: GoToOptions) {
  //   await this.waitForNavigation(options)
  // }

  /**
   * Navigate to the URL
   */
  async goto(url: string, options?: GoToOptions) {
    options = options ?? {};
    await Promise.all([
      retryDeadline(
        this.#celestial.Page.navigate({ url, ...options }),
        this.timeout,
      ),
      this.waitForNavigation(options),
    ]);
  }

  /**
   * Capture screenshot of page
   *
   * @example
   * ```ts
   * const pdf = await page.pdf();
   * Deno.writeFileSync("page.pdf", pdf)
   * ```
   */
  async pdf(opts?: PdfOptions): Promise<Uint8Array> {
    opts = opts ?? {};
    const { data } = await retryDeadline(
      this.#celestial.Page.printToPDF(opts),
      this.timeout,
    );
    return convertToUint8Array(data);
  }

  /**
   * Reload the given page
   *
   * @example
   * ```ts
   * await page.reload()
   * ```
   */
  async reload(options?: WaitForOptions) {
    await Promise.all([
      retryDeadline(this.#celestial.Page.reload({}), this.timeout),
      this.waitForNavigation(options),
    ]);
  }

  /**
   * Capture screenshot of page
   *
   * @example
   * ```ts
   * const screenshot = await page.screenshot();
   * Deno.writeFileSync("screenshot.png", screenshot)
   * ```
   */
  async screenshot(opts?: ScreenshotOptions) {
    opts = opts ?? {};
    const { data } = await retryDeadline(
      this.#celestial.Page.captureScreenshot(opts),
      this.timeout,
    );
    return convertToUint8Array(data);
  }

  /**
   * The current URL of the page
   */
  get url() {
    return this.#url;
  }

  /**
   * Runs a function in the context of the page until it returns a truthy value.
   */
  async waitForFunction<T, R extends AnyArray>(
    func: EvaluateFunction<T, R>,
    evaluateOptions?: EvaluateOptions<R>,
  ) {
    // TODO(lino-levan): Make this easier to read
    await deadline(
      (async () => {
        while (true) {
          const result = await this.evaluate(func, evaluateOptions);

          if (result) {
            return result;
          }
        }
      })(),
      this.timeout,
    );
  }

  /**
   * Waits for the page to navigate to a new URL or to reload. It is useful when you run code that will indirectly cause the page to navigate.
   */
  async waitForNavigation(options?: WaitForOptions) {
    options = options ?? { waitUntil: "networkidle2" };

    if (options.waitUntil !== "load") {
      await this.waitForNavigation({ waitUntil: "load" });
    }

    return retryDeadline(
      new Promise<void>((resolve) => {
        if (options?.waitUntil === "load") {
          const callback = () => {
            resolve();
            this.#celestial.removeEventListener(
              "Page_loadEventFired",
              callback,
            );
          };
          this.#celestial.addEventListener("Page.loadEventFired", callback);
        } else if (options?.waitUntil === "networkidle0") {
          this.waitForNetworkIdle({ idleTime: 500 }).then(() => {
            resolve();
          });
        } else {
          this.waitForNetworkIdle({ idleTime: 500, idleConnections: 2 }).then(
            () => {
              resolve();
            },
          );
        }
      }),
      this.timeout,
    );
  }

  /**
   * Create a promise which resolves when network is idle
   */
  waitForNetworkIdle(options?: WaitForNetworkIdleOptions) {
    const idleTime = options?.idleTime ?? 500;
    const idleConnections = options?.idleConnections ?? 0;

    return retryDeadline(
      new Promise<void>((resolve) => {
        const timeoutDone = () => {
          this.#celestial.removeEventListener(
            "Network_requestWillBeSent",
            requestStarted,
          );
          this.#celestial.removeEventListener(
            "Network_loadingFailed",
            requestFinished,
          );
          this.#celestial.removeEventListener(
            "Network_loadingFinished",
            requestFinished,
          );
          resolve();
        };

        let timeout = setTimeout(timeoutDone, idleTime);

        let inflight = 0;

        const requestStarted = () => {
          inflight++;
          if (inflight > idleConnections) {
            clearTimeout(timeout);
          }
        };

        const requestFinished = () => {
          if (inflight === 0) return;
          inflight--;
          if (inflight === idleConnections) {
            timeout = setTimeout(timeoutDone, idleTime);
          }
        };

        this.#celestial.addEventListener(
          "Network.requestWillBeSent",
          requestStarted,
        );
        this.#celestial.addEventListener(
          "Network.loadingFailed",
          requestFinished,
        );
        this.#celestial.addEventListener(
          "Network.loadingFinished",
          requestFinished,
        );
      }),
      this.timeout,
    );
  }

  /**
   * Wait for the `selector` to appear in page. If at the moment of calling the method the `selector` already exists, the method will return immediately. If the `selector` doesn't appear after the timeout milliseconds of waiting, the function will throw.
   *
   * @example
   * ```ts
   * await page.waitForSelector(".class");
   * ```
   */
  async waitForSelector(selector: string) {
    const root = await this.#getRoot();
    return root.waitForSelector(selector);
  }

  /**
   * Do not use if there is an alterate way of doing your thing
   *
   * @example
   * ```ts
   * await page.screenshot();
   * await page.waitForTimeout(2000);
   * await page.screenshot();
   * ```
   */
  async waitForTimeout(timeout: number) {
    await new Promise((r) => setTimeout(r, timeout));
  }
}
