import Controller from "./controller";
import { EventBroker } from "./event";
import { StreamProxyConstructor } from "./stream";
import { logger } from "./utils";

/**
 * An event map for `CalmLake`.
 */
interface CalmLakeEventMap<R> {
  data: R;
  error: Error;
}

interface CalmLakeOptions {
  maxBufferSize: number;
}

const defaultOptions: CalmLakeOptions = {
  maxBufferSize: 65536
};

/**
 * A simple helper for do these.
 *
 * 1. Manage a stream proxy when it is broken.
 * 2. Keep data into the buffer and resend them.
 */
export class CalmLake<T, R> extends EventBroker<CalmLakeEventMap<R>> {
  /**
   * A controller to manage a stream proxy.
   */
  private readonly controller: Controller<T, R>;

  /**
   * To connect with a stream proxy lazily, it checks if it is a first time to request.
   */
  private initial: boolean = true;

  /**
   * It would be false when it calls `destroy` method.
   * After that, all operations would be ignored.
   */
  private running: boolean = true;

  /**
   * A buffer to store data which cannot be sent because a stream is broken.
   * It will be sent after recovering it.
   */
  private buffer: T[] = [];

  /**
   * Options for lake such as `maxBufferSize`.
   */
  private readonly options: CalmLakeOptions;

  /**
   * Create a new `CalmLake` with a constructor of a stream proxy.
   *
   * @param proxyConstructor A constructor to create a new stream proxy.
   */
  constructor(
    proxyConstructor: StreamProxyConstructor<T, R>,
    options?: Partial<CalmLakeOptions>
  ) {
    super();
    this.controller = new Controller<T, R>(proxyConstructor)
      .on("data", data => this.fire("data", data))
      .on("error", error => this.fire("error", error))
      .on("ready", this.onReady);
    this.options = { ...options, ...defaultOptions };
  }

  /**
   * Check if the buffer is empty.
   */
  public get empty() {
    return this.buffer.length === 0;
  }

  /**
   * Try to send a data via a stream proxy, first.
   * If can't, keep it into the buffer and retry later at `flush` method.
   *
   * Note: If the buffer is full by `maxBufferSize`, it will throw an error
   * named as "BufferOverflow".
   */
  public send = (data: T) => {
    if (!this.running) {
      return false;
    }
    if (this.buffer.length >= this.options.maxBufferSize) {
      throw new Error("BufferOverflow");
    }
    this.buffer.push(data);

    // It should check `initial` to delay to first connect until it is needed.
    if (this.initial) {
      logger.debug(`[SSP][Lake]`, `Try to lazy connect.`);
      this.initial = false;
      this.flush();
    }
    // If a controller is not ready, it means `onReady` is called after connected.
    else if (this.controller.ready) {
      this.flush();
    }
    // Anyway, it send this data now or later.
    return true;
  };

  /**
   * Reset data in the buffer and go a next stream proxy.
   */
  public reset = () => {
    this.buffer = [];
    this.controller.goNextProxy();
  };

  /**
   * Set `this.running` to false so all operation can be rejected after this.
   * And call `this.controller.destroy` method.
   */
  public destroy = () => {
    this.running = false;
    this.buffer = [];
    this.controller.destroy();
  };

  /**
   * Try to flush all data in the buffer with a controller.
   * If a controller is not ready due to some errors, it will give up now
   * but it will send them after calling `onReady` function from a controller.
   */
  private flush = () => {
    if (!this.running) {
      logger.debug(`[SSP][Lake]`, `Cannot flush because it is halted.`);
      return false;
    }
    while (this.buffer.length > 0) {
      const oldOne = this.buffer[0];
      // If it cannot send a data, try it later.
      if (!this.controller.send(oldOne)) {
        logger.debug(`[SSP][Lake]`, `Cannot send a data via controller.`);
        break;
      }
      this.buffer.shift();
      logger.debug(`[SSP][Lake]`, `Shift old data from the buffer.`);
    }
    // In this time, a buffer can have some data cannot be sent.
    // But it will send them after calling `onReady` function from a controller.
  };

  /**
   * This is a callback to retrieve the ready signal from a controller when
   * a stream proxy is ready to send a data.
   *
   * It means a stream proxy is connected in first time or recovered from a failure
   * so it can send data from the buffer to this stream proxy now.
   */
  private onReady = () => {
    if (!this.running) {
      logger.debug(`[SSP][Lake]`, `Cannot be ready because it is halted.`);
      return false;
    }
    logger.debug(`[SSP][Lake]`, `Shift old data from the buffer.`);
    this.flush();
  };
}

export const calm = <T, R>(
  proxyConstructor: StreamProxyConstructor<T, R>,
  options?: Partial<CalmLakeOptions>
) => new CalmLake<T, R>(proxyConstructor, options);
