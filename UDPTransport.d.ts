import {
  Grammar,
  Logger,
  OutgoingRequestMessage,
  Transport as TransportBase
} from "sip.js/lib/core";
import { TypeStrings } from "sip.js/lib/Enums";
import { Exceptions } from "sip.js/lib/Exceptions";
import { Utils } from "sip.js/lib/Utils";
import UDPSocket  from './UDPSocket.d.ts';

export enum TransportStatus {
  STATUS_CONNECTING,
  STATUS_OPEN,
  STATUS_CLOSING,
  STATUS_CLOSED
}

export interface WsServer {
  scheme: string;
  sipUri: string;
  wsUri: string;
  weight: number;
  isError: boolean;
}

export interface Configuration {
  wsServers: Array<WsServer>;
  connectionTimeout: number;
  maxReconnectionAttempts: number;
  reconnectionTimeout: number;
  keepAliveInterval: number;
  keepAliveDebounce: number;
  traceSip: boolean;
}

const computeKeepAliveTimeout = (upperBound: number): number => {
  const lowerBound: number = upperBound * 0.8;
  return 1000 * (Math.random() * (upperBound - lowerBound) + lowerBound);
};

const getSocketConfig = (wsUri:string) => ({
  host: wsUri.replace(/[a-z]+:\/\/|:[0-9]+/g, ''),
  port : Number(wsUri.replace(/[a-z]+:\/\/|[0-9]+\.|[0-9]+\:/g, ''))
});

export class Transport extends TransportBase {
  public static readonly C = TransportStatus;
  public type: TypeStrings;
  public server: WsServer;
  public ws: any;

  private connectionPromise: Promise<any> | undefined;
  private connectDeferredResolve: ((obj: any) => void) | undefined;
  private connectDeferredReject: ((obj: any) => void) | undefined;
  private connectionTimeout: any | undefined;
  private disconnectionPromise: Promise<any> | undefined;
  private disconnectDeferredResolve: ((obj: any) => void) | undefined;
  private reconnectionAttempts: number;
  private reconnectTimer: any | undefined;
  private keepAliveInterval: any | undefined;
  private keepAliveDebounceTimeout: any | undefined;
  private status: TransportStatus;
  private configuration: Configuration;
  private boundOnOpen: any;
  private boundOnMessage: any;
  private boundOnClose: any;
  private boundOnError: any;

  constructor(logger: Logger, options: any = {}) {
    super(logger, options);
    this.type = TypeStrings.Transport;
    this.logger = logger || {
      log: (content:string) => {
        console.log(content);
      }
    };
    this.reconnectionAttempts = 0;
    this.status = TransportStatus.STATUS_CONNECTING;
    this.configuration = this.loadConfig(options);
    this.server = this.configuration.wsServers[0];
    this.boundOnOpen = this.onOpen.bind(this);
    this.boundOnMessage = this.onMessage.bind(this);
    this.boundOnClose = this.onClose.bind(this);
    this.boundOnError = this.onWebsocketError.bind(this);
  }

  public isConnected(): boolean {
    return this.status === TransportStatus.STATUS_OPEN;
  }

  protected sendPromise(msg: OutgoingRequestMessage | string, options: any = {}): Promise<{msg: string}> {
    if (!this.statusAssert(TransportStatus.STATUS_OPEN, options.force)) {
      this.onError("Unable to send message - WebSocket not open");
      return Promise.reject();
    }

    const message: string = msg.toString();

    if (this.ws) {
      if (this.configuration.traceSip) {
        this.logger.log("Sending WebSocket message:\n\n" + message + "\n");
      }
      this.ws.send(message, (sendResult:any)=>{
        if(this.configuration.traceSip){
          const sent = sendResult.resultCode === 0;
          this.logger.log(`Sent:${sent}`);
          this.logger.log(`SentResult >>> ${JSON.stringify(sendResult)}`);
        }
      });
      return Promise.resolve({msg: message});
    } else {
      this.onError("Unable to send message - WebSocket does not exist");
      return Promise.reject();
    }
  }

  protected disconnectPromise(options: any = {}): Promise<any> {
    if (this.disconnectionPromise) { // Already disconnecting. Just return this.
      return this.disconnectionPromise;
    }
    options.code = options.code || 1000;

    if (!this.statusTransition(TransportStatus.STATUS_CLOSING, options.force)) {
      if (this.status === TransportStatus.STATUS_CLOSED) { // Websocket is already closed
        return Promise.resolve({overrideEvent: true});
      } else if (this.connectionPromise) { // Websocket is connecting, cannot move to disconneting yet
        return this.connectionPromise.then(() => Promise.reject("The websocket did not disconnect"))
        .catch(() => Promise.resolve({overrideEvent: true}));
      } else {
        // Cannot move to disconnecting, but not in connecting state.
        return Promise.reject("The websocket did not disconnect");
      }
    }
    this.emit("disconnecting");
    this.disconnectionPromise = new Promise((resolve, reject) => {
      this.disconnectDeferredResolve = resolve;

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }

      if (this.ws) {
        this.stopSendingKeepAlives();
        this.logger.log("Closing WebSocket " + this.server.wsUri);
        this.ws.close();
      } else {
        reject("Attempted to disconnect but the websocket doesn't exist");
      }
    });
    return this.disconnectionPromise;
  }

  protected connectPromise(options: any = {}) {
    if (this.status === TransportStatus.STATUS_CLOSING && !options.force) {
      return Promise.reject("WebSocket " + this.server.wsUri + " is closing");
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.server = this.server || this.getNextWsServer(options.force);

    this.connectionPromise = new Promise((resolve, reject) => {
      if ((this.status === TransportStatus.STATUS_OPEN || this.status === TransportStatus.STATUS_CLOSING)
        && !options.force) {
        this.logger.log("WebSocket " + this.server.wsUri + " is already connected");
        reject("Failed status check - attempted to open a connection but already open/closing");
        return;
      }

      this.connectDeferredResolve = resolve;
      this.connectDeferredReject = reject;

      this.status = TransportStatus.STATUS_CONNECTING;
      this.emit("connecting");
      const { host, port } = getSocketConfig(this.server.wsUri);
      this.logger.log(`Connecting to WebSocket on ${host}:${port}...`);
      this.disposeWs();
      try {
        this.ws = new UDPSocket();
        this.ws.connect(host, port, () => {
          this.status = TransportStatus.STATUS_CLOSED;
          this.onError(`Failed to create a UDP socket >>> ${this.server.wsUri}`);
          reject("Failed to create a UDP socket!!");
        },  (result:string) => {
            this.ws.addListener("open", this.boundOnOpen);
            this.ws.addListener("message", this.boundOnMessage);
            this.ws.addListener("close", this.boundOnClose);
            this.ws.addListener("error", this.boundOnError);
            this.ws.emit("open");
        });
      } catch (e) {
        this.ws = null;
        this.statusTransition(TransportStatus.STATUS_CLOSED, true);
        this.onError("Error connecting to WebSocket " + this.server.wsUri + ":" + e);
        reject("Failed to create a websocket");
        this.connectDeferredResolve = undefined;
        this.connectDeferredReject = undefined;
        return;
      }

      if (!this.ws) {
        reject("Unexpected instance websocket not set");
        this.connectDeferredResolve = undefined;
        this.connectDeferredReject = undefined;
        return;
      }

      this.connectionTimeout = setTimeout(() => {
        this.statusTransition(TransportStatus.STATUS_CLOSED);
        this.logger.log("Took too long to connect - exceeded time set in configuration.connectionTimeout: " +
          this.configuration.connectionTimeout + "s");
        this.emit("disconnected", {code: 1000});
        this.connectionPromise = undefined;
        reject("Connection timeout");
        this.connectDeferredResolve = undefined;
        this.connectDeferredReject = undefined;
        const ws = this.ws;
        this.disposeWs();
        ws.close(1000);
      }, this.configuration.connectionTimeout * 1000);

    });

    return this.connectionPromise;
  }

  protected onMessage(e: any): void {
    const data: any  = e.data;
    let finishedData: string;
    // CRLF Keep Alive response from server. Clear our keep alive timeout.
    if (/^(\r\n)+$/.test(data)) {
      this.clearKeepAliveTimeout();

      if (this.configuration.traceSip === true) {
        this.logger.log("received WebSocket message with CRLF Keep Alive response");
      }
      return;
    } else if (!data) {
      this.logger.log("received empty message, message discarded");
      return;
    } else if (typeof data !== "string") { // WebSocket binary message.
      try {
        // the UInt8Data was here prior to types, and doesn't check
        finishedData = String.fromCharCode.apply(null, (new Uint8Array(data) as unknown as Array<number>));
      } catch (err) {
        this.logger.log("received WebSocket binary message failed to be converted into string, message discarded");
        return;
      }

      if (this.configuration.traceSip === true) {
        this.logger.log("received WebSocket binary message:\n\n" + data + "\n");
      }
    } else { // WebSocket text message.
      if (this.configuration.traceSip === true) {
        this.logger.log("received WebSocket text message:\n\n" + data + "\n");
      }
      finishedData = data;
    }

    this.emit("message", finishedData);
  }

  // Transport Event Handlers

  private onOpen(): void  {
    if (this.status === TransportStatus.STATUS_CLOSED) { // Indicated that the transport thinks the ws is dead already
      const ws = this.ws;
      this.disposeWs();
      ws.close(1000);
      return;
    }
    this.statusTransition(TransportStatus.STATUS_OPEN, true);
    this.emit("connected");
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = undefined;
    }

    this.logger.log("WebSocket " + this.server.wsUri + " connected");

    // Clear reconnectTimer since we are not disconnected
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    // Reset reconnectionAttempts
    this.reconnectionAttempts = 0;

    // Reset disconnection promise so we can disconnect from a fresh state
    this.disconnectionPromise = undefined;
    this.disconnectDeferredResolve = undefined;

    // Start sending keep-alives
    this.startSendingKeepAlives();

    if (this.connectDeferredResolve) {
      this.connectDeferredResolve({overrideEvent: true});
      this.connectDeferredResolve = undefined;
      this.connectDeferredReject = undefined;
    } else {
      this.logger.log("Unexpected websocket.onOpen with no connectDeferredResolve");
    }
  }

  private onClose(e: any): void {
    this.logger.log("WebSocket disconnected (code: " + e.code + (e.reason ? "| reason: " + e.reason : "") + ")");

    if (this.status !== TransportStatus.STATUS_CLOSING) {
      this.logger.log("WebSocket closed without SIP.js requesting it");
      this.emit("transportError");
    }

    this.stopSendingKeepAlives();

    // Clean up connection variables so we can connect again from a fresh state
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
    }
    if (this.connectDeferredReject) {
      this.connectDeferredReject("Websocket Closed");
    }
    this.connectionTimeout = undefined;
    this.connectionPromise = undefined;
    this.connectDeferredResolve = undefined;
    this.connectDeferredReject = undefined;

    // Check whether the user requested to close.
    if (this.disconnectDeferredResolve) {
      this.disconnectDeferredResolve({ overrideEvent: true });
      this.statusTransition(TransportStatus.STATUS_CLOSED);
      this.disconnectDeferredResolve = undefined;
      return;
    }

    this.statusTransition(TransportStatus.STATUS_CLOSED, true);
    this.emit("disconnected", {code: e.code, reason: e.reason});

    this.disposeWs();
    this.reconnect();
  }

  private disposeWs(): void {
    if (this.ws) {
      this.ws.removeListener("open", this.boundOnOpen);
      this.ws.removeListener("message", this.boundOnMessage);
      this.ws.removeListener("close", this.boundOnClose);
      this.ws.removeListener("error", this.boundOnError);
      this.ws = undefined;
    }
  }

  private onError(e: any): void {
    this.logger.log("Transport error: " + e);
    this.emit("transportError");
  }

  private onWebsocketError(error:any): void {
    if(this.configuration.traceSip){
      this.logger.log(error);
    }
    this.onError("The Websocket had an error");
  }

  private reconnect(): void {
    if (this.reconnectionAttempts > 0) {
      this.logger.log("Reconnection attempt " + this.reconnectionAttempts + " failed");
    }

    if (this.noAvailableServers()) {
      this.logger.log("Attempted to get next ws server but there are no available ws servers left");
      this.logger.log("No available ws servers left - going to closed state");
      this.statusTransition(TransportStatus.STATUS_CLOSED, true);
      this.emit("closed");
      this.resetServerErrorStatus();
      return;
    }

    if (this.isConnected()) {
      this.logger.log("Attempted to reconnect while connected - forcing disconnect");
      this.disconnect({force: true});
    }

    this.reconnectionAttempts += 1;

    if (this.reconnectionAttempts > this.configuration.maxReconnectionAttempts) {
      this.logger.log("Maximum reconnection attempts for WebSocket " + this.server.wsUri);
      this.logger.log("Transport " + this.server.wsUri + " failed | connection state set to 'error'");
      this.server.isError = true;
      this.emit("transportError");
      if (!this.noAvailableServers()) {
        this.server = this.getNextWsServer();
      }
      this.reconnectionAttempts = 0;
      this.reconnect();
    } else {
      this.logger.log("Trying to reconnect to WebSocket " +
        this.server.wsUri + " (reconnection attempt " + this.reconnectionAttempts + ")");
      this.reconnectTimer = setTimeout(() => {
        this.connect();
        this.reconnectTimer = undefined;
      }, (this.reconnectionAttempts === 1) ? 0 : this.configuration.reconnectionTimeout * 1000);
    }
  }

  private resetServerErrorStatus(): void {
    for (const websocket of this.configuration.wsServers) {
      websocket.isError = false;
    }
  }

  private getNextWsServer(force: boolean = false): WsServer {
    if (this.noAvailableServers()) {
      this.logger.log("attempted to get next ws server but there are no available ws servers left");
      throw new Error("Attempted to get next ws server, but there are no available ws servers left.");
    }
    // Order servers by weight
    let candidates: Array<WsServer> = [];

    for (const wsServer of this.configuration.wsServers) {
      if (wsServer.isError && !force) {
        continue;
      } else if (candidates.length === 0) {
        candidates.push(wsServer);
      } else if (wsServer.weight > candidates[0].weight) {
        candidates = [wsServer];
      } else if (wsServer.weight === candidates[0].weight) {
        candidates.push(wsServer);
      }
    }

    const idx: number = Math.floor(Math.random() * candidates.length);
    return candidates[idx];
  }

  private noAvailableServers(): boolean {
    for (const server of this.configuration.wsServers) {
      if (!server.isError) {
        return false;
      }
    }
    return true;
  }

  // KeepAlive Stuff

  private sendKeepAlive(): Promise<any> | void {
    if (this.keepAliveDebounceTimeout) {
      return;
    }

    this.keepAliveDebounceTimeout = setTimeout(() => {
      this.emit("keepAliveDebounceTimeout");
      this.clearKeepAliveTimeout();
    }, this.configuration.keepAliveDebounce * 1000);

    return this.send("\r\n\r\n");
  }

  private clearKeepAliveTimeout(): void {
    if (this.keepAliveDebounceTimeout) {
      clearTimeout(this.keepAliveDebounceTimeout);
    }
    this.keepAliveDebounceTimeout = undefined;
  }

  private startSendingKeepAlives(): void {
    if (this.configuration.keepAliveInterval && !this.keepAliveInterval) {
      this.keepAliveInterval = setInterval(() => {
        this.sendKeepAlive();
        this.startSendingKeepAlives();
      }, computeKeepAliveTimeout(this.configuration.keepAliveInterval));
    }
  }

  private stopSendingKeepAlives(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
    if (this.keepAliveDebounceTimeout) {
      clearTimeout(this.keepAliveDebounceTimeout);
    }
    this.keepAliveInterval = undefined;
    this.keepAliveDebounceTimeout = undefined;
  }

  private statusAssert(status: TransportStatus, force: boolean): boolean {
    if (status === this.status) {
      return true;
    } else {
      if (force) {
        this.logger.log("Attempted to assert " +
          Object.keys(TransportStatus)[this.status] + " as " +
          Object.keys(TransportStatus)[status] + "- continuing with option: 'force'");
        return true;
      } else {
        this.logger.log("Tried to assert " +
        Object.keys(TransportStatus)[status] + " but is currently " +
        Object.keys(TransportStatus)[this.status]);
        return false;
      }
    }
  }

  private statusTransition(status: TransportStatus, force: boolean = false): boolean {
    this.logger.log("Attempting to transition status from " +
      Object.keys(TransportStatus)[this.status] + " to " +
      Object.keys(TransportStatus)[status]);
    if ((status === TransportStatus.STATUS_CONNECTING && this.statusAssert(TransportStatus.STATUS_CLOSED, force)) ||
        (status === TransportStatus.STATUS_OPEN && this.statusAssert(TransportStatus.STATUS_CONNECTING, force)) ||
        (status === TransportStatus.STATUS_CLOSING && this.statusAssert(TransportStatus.STATUS_OPEN, force))    ||
        (status === TransportStatus.STATUS_CLOSED)) {
      this.status = status;
      return true;
    } else {
      this.logger.log("Status transition failed - result: no-op - reason:" +
        " either gave an nonexistent status or attempted illegal transition");
      return false;
    }
  }

  private loadConfig(configuration: any): Configuration {
    const settings: Configuration = {
      wsServers: configuration.wsServers,
      connectionTimeout: configuration.connectionTimeout,
      maxReconnectionAttempts: configuration.maxReconnectionAttempts,
      reconnectionTimeout: configuration.reconnectionTimeout,
      keepAliveInterval: configuration.keepAliveInterval,
      keepAliveDebounce: configuration.keepAliveDebounce,
      traceSip: configuration.traceSip
    };

    const configCheck: {mandatory: {[name: string]: any}, optional: {[name: string]: any}} =
      this.getConfigurationCheck();

    // Check Mandatory parameters
    for (const parameter in configCheck.mandatory) {
      if (!configuration.hasOwnProperty(parameter)) {
        throw new Exceptions.ConfigurationError(parameter);
      } else {
        const value: any = configuration[parameter];
        const checkedValue: any = configCheck.mandatory[parameter](value);
        if (checkedValue !== undefined) {
          (settings as any)[parameter] = checkedValue;
        } else {
          throw new Exceptions.ConfigurationError(parameter, value);
        }
      }
    }

    // Check Optional parameters
    for (const parameter in configCheck.optional) {
      if (configuration.hasOwnProperty(parameter)) {
        const value = configuration[parameter];
        if ((value instanceof Array && value.length === 0) ||
            (value === null || value === "" || value === undefined) ||
            (typeof(value) === "number" && isNaN(value))) { continue; }

        const checkedValue: any = configCheck.optional[parameter](value);
        if (checkedValue !== undefined) {
          (settings as any)[parameter] = checkedValue;
        } else {
          throw new Exceptions.ConfigurationError(parameter, value);
        }
      }
    }

    const skeleton: any = {}; 
    for (const parameter in settings) {
      if (settings.hasOwnProperty(parameter)) {
        skeleton[parameter] = {
          value: (settings as any)[parameter],
        };
      }
    }
    const returnConfiguration: Configuration = Object.defineProperties({}, skeleton);

    this.logger.log("configuration parameters after validation:");
    for (const parameter in settings) {
      if (settings.hasOwnProperty(parameter)) {
        this.logger.log("· " + parameter + ": " + JSON.stringify((settings as any)[parameter]));
      }
    }

    return returnConfiguration;
  }

  private getConfigurationCheck(): {mandatory: {[name: string]: any}, optional: {[name: string]: any}} {
    return {
      mandatory: {
      },

      optional: {
        wsServers: (wsServers: any): any => {
          if (typeof wsServers === "string") {
            wsServers = [{wsUri: wsServers}];
          } else if (wsServers instanceof Array) {
            for (let idx = 0; idx < wsServers.length; idx++) {
              if (typeof wsServers[idx] === "string") {
                wsServers[idx] = {wsUri: wsServers[idx]};
              }
            }
          } else {
            return;
          }

          if (wsServers.length === 0) {
            return false;
          }

          for (const wsServer of wsServers) {
            if (!wsServer.wsUri) {
              return;
            }
            if (wsServer.weight && !Number(wsServer.weight)) {
              return;
            }

            const url: any | -1 = Grammar.parse(wsServer.wsUri, "absoluteURI");

            if (url === -1) {
              return;
            } else if (["wss", "ws", "udp"].indexOf(url.scheme) < 0) {
              return;
            } else {
              wsServer.sipUri = "<sip:" + url.host +
                (url.port ? ":" + url.port : "") + ";transport=" + url.scheme.replace(/^wss$/i, "ws") + ";lr>";

              if (!wsServer.weight) {
                wsServer.weight = 0;
              }

              wsServer.isError = false;
              wsServer.scheme = url.scheme.toUpperCase();
            }
          }
          return wsServers;
        },

        keepAliveInterval: (keepAliveInterval: string): number | undefined => {
          if (Utils.isDecimal(keepAliveInterval)) {
            const value: number = Number(keepAliveInterval);
            if (value > 0) {
              return value;
            }
          }
        },

        keepAliveDebounce: (keepAliveDebounce: string): number | undefined => {
          if (Utils.isDecimal(keepAliveDebounce)) {
            const value = Number(keepAliveDebounce);
            if (value > 0) {
              return value;
            }
          }
        },

        traceSip: (traceSip: boolean): boolean | undefined => {
          if (typeof traceSip === "boolean") {
            return traceSip;
          }
        },

        connectionTimeout: (connectionTimeout: string): number | undefined => {
          if (Utils.isDecimal(connectionTimeout)) {
            const value = Number(connectionTimeout);
            if (value > 0) {
              return value;
            }
          }
        },

        maxReconnectionAttempts: (maxReconnectionAttempts: string): number | undefined => {
          if (Utils.isDecimal(maxReconnectionAttempts)) {
            const value: number = Number(maxReconnectionAttempts);
            if (value >= 0) {
              return value;
            }
          }
        },

        reconnectionTimeout: (reconnectionTimeout: string): number | undefined => {
          if (Utils.isDecimal(reconnectionTimeout)) {
            const value: number = Number(reconnectionTimeout);
            if (value > 0) {
              return value;
            }
          }
        }

      }
    };
  }
}